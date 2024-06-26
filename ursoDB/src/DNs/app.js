const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const axios = require('axios');
const logger = require('../logger');
const MyRaft = require('./MyRaft'); 
const WinstonTransport = require('./winstonTransportLayer');
const kvStore = require('../utils/kvStore'); 

const app = express();
app.use(bodyParser.json());
app.use(express.json());

const adminRoute = require('./routes/admin');
const dbRoute = require('./routes/db');
const statsRoute = require('./routes/stats');
const statusRoute = require('./routes/status');
const stopRoute = require('./routes/stop');

app.use('/admin', adminRoute);
app.use('/db', dbRoute);
app.use('/stats', statsRoute);
app.use('/status', statusRoute);
app.use('/stop', stopRoute);

// Load configuration
const config = JSON.parse(fs.readFileSync('configure.json', 'utf8'));
const nodeId = process.env.NODE_ID || 'node1';
const nodeConfig = config.DNs.flatMap(dn => dn.servers).find(server => server.name === nodeId);

if (!nodeConfig) {
  throw new Error(`Node configuration not found for NODE_ID ${nodeId}`);
}

const port = nodeConfig.port;
const peers = config.DNs.flatMap(dn => dn.servers)
                        .filter(server => server.name !== nodeId && server.name.startsWith(nodeConfig.name.split('s')[0]))
                        .map(server => `http://localhost:${server.port}`);

// Initialize Raft node
const raft = new MyRaft({
  address: `http://localhost:${port}`,
  'election min': '3 seconds',  
  'election max': '6 seconds',  
  Log: WinstonTransport,
  logger: logger, // Pass the logger
  peers: peers 
});


raft.on('term change', (term) => {
  logger.info(`Node ${nodeId} - Term changed to ${term}`);
});

raft.on('leader change', (leader) => {
  logger.info(`Node ${nodeId} - Leader changed to ${leader}`);
  if (raft.address === leader) {
    const rpConfig = config.RP;
    axios.post(`http://${rpConfig.host}:${rpConfig.port}/set_master`, {
      masterId: nodeId
    }).catch(error => {
      logger.error('Error announcing leader:', error.message);
    });
  }
});


app.post('/raft', (req, res) => {
  logger.info(`Node ${nodeId} - Received Raft message: ${JSON.stringify(req.body)}`);
  raft.emit(req.body.type, req.body);
  res.status(200).send();
});

// Join the raft cluster
peers.forEach(peer => {
  logger.info(`Node ${nodeId} - Joining peer at ${peer}`);
  raft.join(peer, (packet) => {
    axios.post(`${peer}/raft`, packet)
      .then(response => {
        logger.info(`Packet sent to ${peer}`);
      })
      .catch(error => {
        logger.error(`Error sending packet to ${peer}: ${error.message}`);
      });
  });
});

// Handle heartbeat timeout
raft.on('heartbeat timeout', () => {
  logger.info(`Node ${nodeId} - Heartbeat timeout, promoting to candidate`);
  raft.promote();
});

// Handle vote requests
raft.on('vote', (vote) => {
  logger.info(`Node ${nodeId} - Received vote request from ${vote.address}`);
  const voteGranted = true; // or add logic to determine if the vote should be granted
  raft.emit('vote response', {
    address: vote.address,
    term: vote.term,
    voteGranted: voteGranted
  });
});

// Handle state changes
raft.on('leader', () => {
  logger.info(`Node ${nodeId} - I am the leader`);
});

raft.on('follower', () => {
  logger.info(`Node ${nodeId} - I am a follower`);
});

raft.on('candidate', () => {
  logger.info(`Node ${nodeId} - I am a candidate`);
});

// Create a key-value pair
app.post('/db/c', (req, res) => {
  const { key, value } = req.body;
  const result = kvStore.createKeyValuePair(key, value); // Use the kvStore module
  logger.info(`Created key-value pair: ${key} - ${JSON.stringify(value)}`);
  res.json(result);
});

// Read the value associated with a key
app.get('/db/r/:key', (req, res) => {
  const { key } = req.params;
  const value = kvStore.readValueByKey(key); // Use the kvStore module
  if (value !== null) {
    logger.info(`Read value for key: ${key}`);
    res.json(value);
  } else {
    logger.error(`Key not found: ${key}`);
    res.status(404).send('Key not found');
  }
});

// Update the value associated with a key
app.put('/db/u/:key', (req, res) => {
  const { key } = req.params;
  const newValue = req.body;
  const result = kvStore.updateValueByKey(key, newValue); // Use the kvStore module
  if (result !== null) {
    logger.info(`Updated value for key: ${key}`);
    res.json(result);
  } else {
    logger.error(`Key not found: ${key}`);
    res.status(404).send('Key not found');
  }
});

// Delete a key-value pair
app.delete('/db/d/:key', (req, res) => {
  const { key } = req.params;
  const success = kvStore.deleteKeyValuePair(key); // Use the kvStore module
  if (success) {
    logger.info(`Deleted key-value pair: ${key}`);
    res.send('Key-value pair deleted');
  } else {
    logger.error(`Key not found: ${key}`);
    res.status(404).send('Key not found');
  }
});

// Start the server
app.listen(port, () => {
  logger.info(`DN server running on port ${port} as ${nodeId}`);
  raft.emit('initialize');
});

module.exports = app;
