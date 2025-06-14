// SignalK Peplink Monitor Plugin
// File: index.js

const { spawn } = require('child_process');
const path = require('path');

module.exports = function(app) {
  const plugin = {};
  let pollingInterval;
  let options = {};

  plugin.id = 'peplink-monitor';
  plugin.name = 'Peplink Monitor';
  plugin.description = 'Monitor Peplink router WAN connections and cellular signal quality';

  plugin.schema = {
    type: 'object',
    required: ['host', 'password', 'connectionName'],
    properties: {
      host: {
        type: 'string',
        title: 'Router IP Address',
        description: 'IP address of the Peplink router'
      },
      port: {
        type: 'number',
        title: 'SSH Port',
        description: 'SSH port for router connection',
        default: 22
      },
      username: {
        type: 'string',
        title: 'Username',
        description: 'SSH username for router login',
        default: 'admin'
      },
      password: {
        type: 'string',
        title: 'Password',
        description: 'SSH password for router login'
      },
      connectionName: {
        type: 'string',
        title: 'Connection Name to Monitor',
        description: 'Your name for the WAN connection to monitor (e.g., T-Mobile, Verizon)'
      },
      pollInterval: {
        type: 'number',
        title: 'Poll Interval (seconds)',
        description: 'How often to check the cellular signal quality',
        default: 30,
        minimum: 10
      }
    }
  };

  plugin.start = function(configuration) {
    options = configuration;
    
    app.debug('Starting Peplink Monitor with configuration:', {
      host: options.host,
      port: options.port || 22,
      username: options.username || 'admin',
      connectionName: options.connectionName,
      pollInterval: options.pollInterval || 30
    });

    // Start polling
    startPolling();
  };

  plugin.stop = function() {
    app.debug('Stopping Peplink Monitor');
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
  };

  function startPolling() {
    // Initial check
    checkWanStatus();
    
    // Set up recurring checks
    pollingInterval = setInterval(() => {
      checkWanStatus();
    }, (options.pollInterval || 30) * 1000);
  }

  function checkWanStatus() {
    const scriptPath = path.join(__dirname, 'peplink-query.js');
    const child = spawn('node', [scriptPath], {
      env: {
        ...process.env,
        PEPLINK_HOST: options.host,
        PEPLINK_PORT: options.port || 22,
        PEPLINK_USERNAME: options.username || 'admin',
        PEPLINK_PASSWORD: options.password,
        PEPLINK_CONNECTION: options.connectionName
      }
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        try {
          const signalQualityValue = stdout.trim();
          processWanData(signalQualityValue);
        } catch (error) {
          app.error('Failed to process signal quality data:', error.message);
        }
      } else {
        app.error('Failed to get cellular signal quality:', stderr);
      }
    });
  }

  function processWanData(signalQualityValue) {
    if (signalQualityValue === null || signalQualityValue === 'null') {
      app.debug('No cellular signal quality data available');
      return;
    }

    const signalQuality = parseFloat(signalQualityValue);
    
    if (isNaN(signalQuality)) {
      app.error('Invalid signal quality value received:', signalQualityValue);
      return;
    }

    // Publish to SignalK path
    app.handleMessage(plugin.id, {
      updates: [
        {
          source: {
            label: plugin.name,
            type: 'peplink-router',
            src: options.connectionName || 'cellular'
          },
          timestamp: new Date().toISOString(),
          values: [
            {
              path: 'communication.cellular.signalQuality',
              value: signalQuality
            }
          ]
        }
      ]
    });

    app.debug(`Published cellular signal quality: ${(signalQuality * 100).toFixed(1)}%`);
  }

  return plugin;
};