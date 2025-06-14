// Peplink Query Script
// File: peplink-query.js

const { Client } = require('ssh2');

// Get configuration from environment variables
const config = {
  host: process.env.PEPLINK_HOST,
  port: process.env.PEPLINK_PORT || 22,
  username: process.env.PEPLINK_USERNAME || 'admin',
  password: process.env.PEPLINK_PASSWORD,
  connectionName: process.env.PEPLINK_CONNECTION
};

// Signal quality calculation function
function calculateSignalQuality(rssi, sinr, rsrp, rsrq) {
  // Extract numeric values
  rssi = parseFloat(rssi.toString().replace(/[^-0-9.]/g, ''));
  sinr = parseFloat(sinr.toString().replace(/[^-0-9.]/g, ''));
  rsrp = parseFloat(rsrp.toString().replace(/[^-0-9.]/g, ''));
  rsrq = parseFloat(rsrq.toString().replace(/[^-0-9.]/g, ''));

  let rssiScore = 0, sinrScore = 0, rsrpScore = 0, rsrqScore = 0;

  // RSSI scoring (-50 = excellent, -70 = good, -85 = fair, -100+ = poor)
  if (rssi >= -50) rssiScore = 100;
  else if (rssi >= -70) rssiScore = 100 - ((rssi + 50) * 2.5);
  else if (rssi >= -85) rssiScore = 50 - ((rssi + 70) * 2);
  else if (rssi >= -100) rssiScore = 20 - ((rssi + 85) * 1.33);
  else rssiScore = 0;

  // SINR scoring (>20 = excellent, >13 = good, >0 = fair, <0 = poor)
  if (sinr >= 20) sinrScore = 100;
  else if (sinr >= 13) sinrScore = 80 + ((sinr - 13) * 2.86);
  else if (sinr >= 0) sinrScore = 40 + (sinr * 3.08);
  else if (sinr >= -10) sinrScore = (sinr + 10) * 4;
  else sinrScore = 0;

  // RSRP scoring (-80 = excellent, -90 = good, -100 = fair, -110+ = poor)
  if (rsrp >= -80) rsrpScore = 100;
  else if (rsrp >= -90) rsrpScore = 100 - ((rsrp + 80) * 5);
  else if (rsrp >= -100) rsrpScore = 50 - ((rsrp + 90) * 3);
  else if (rsrp >= -110) rsrpScore = 20 - ((rsrp + 100) * 2);
  else rsrpScore = 0;

  // RSRQ scoring (-3 = excellent, -6 = good, -9 = fair, -15+ = poor)
  if (rsrq >= -3) rsrqScore = 100;
  else if (rsrq >= -6) rsrqScore = 100 - ((rsrq + 3) * 16.67);
  else if (rsrq >= -9) rsrqScore = 50 - ((rsrq + 6) * 10);
  else if (rsrq >= -15) rsrqScore = 20 - ((rsrq + 9) * 3.33);
  else rsrqScore = 0;

  // Ensure scores are within bounds
  rssiScore = Math.max(0, Math.min(100, rssiScore));
  sinrScore = Math.max(0, Math.min(100, sinrScore));
  rsrpScore = Math.max(0, Math.min(100, rsrpScore));
  rsrqScore = Math.max(0, Math.min(100, rsrqScore));

  // Weighted average (RSRP and SINR are most important for LTE)
  const overallScore = (rsrpScore * 0.35) + (sinrScore * 0.35) + (rssiScore * 0.20) + (rsrqScore * 0.10);
  
  return `${Math.round(overallScore)}%`;
}

// Convert string to camelCase
function toCamelCase(str) {
  return str.replace(/[^a-zA-Z0-9 ]/g, '')
    .split(' ')
    .map((word, index) => {
      if (index === 0) return word.toLowerCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

// Parse WAN output to JavaScript object
function parseWanOutput(input) {
  const lines = input.split('\n').filter(line => line.trim() !== '');
  const wanConnections = [];
  let currentConnection = null;
  let currentSection = null;
  let currentConnectionSignalMetrics = {};

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check for WAN Connection header
    const connectionMatch = trimmed.match(/^WAN Connection \[(\d+)\]$/);
    if (connectionMatch) {
      if (currentConnection) {
        wanConnections.push(currentConnection);
      }
      
      currentConnection = {
        connectionNumber: parseInt(connectionMatch[1]),
        connectionName: '',
        connectionStatus: '',
        connectionType: '',
        connectionMethod: ''
      };
      currentSection = null;
      currentConnectionSignalMetrics = {};
      continue;
    }

    // Check for section headers
    if (line.match(/^\s{4}[A-Za-z]/) && !line.includes(':')) {
      const sectionName = trimmed.replace(/\s+/g, '');
      const camelCaseName = sectionName.charAt(0).toLowerCase() + sectionName.slice(1);
      currentSection = camelCaseName;
      currentConnection[currentSection] = {};
      continue;
    }

    // Parse key-value pairs
    const kvMatch = trimmed.match(/^(.+?)\s*:\s*(.+)$/);
    if (kvMatch) {
      let key = kvMatch[1].trim();
      let value = kvMatch[2].trim();
      
      const camelKey = toCamelCase(key);
      
      // Convert numeric values
      if (/^\d+$/.test(value)) {
        value = parseInt(value);
      } else if (/^\d+\.\d+$/.test(value)) {
        value = parseFloat(value);
      }

      // Track cellular signal metrics for ALL connections
      if (currentSection === 'cellularStatus') {
        if (['RSSI', 'SINR', 'RSRP', 'RSRQ'].includes(key)) {
          currentConnectionSignalMetrics[key] = value;
          console.error(`Debug: Found ${key}: ${value} for connection ${currentConnection.connectionName}`);
        }
      }

      if (currentSection) {
        currentConnection[currentSection][camelKey] = value;
      } else {
        // Handle DNS Servers as an array
        if (camelKey === 'dnsServers') {
          currentConnection[camelKey] = [value];
        } else {
          currentConnection[camelKey] = value;
        }
      }
    }

    // Handle continuation lines (additional DNS servers)
    if (line.match(/^\s{40,}/) && currentConnection.dnsServers) {
      currentConnection.dnsServers.push(trimmed);
    }
  }

  // Add the last connection
  if (currentConnection) {
    wanConnections.push(currentConnection);
  }

  // Calculate signal quality for connections that have cellular data
  wanConnections.forEach(connection => {
    if (connection.cellularStatus && connection.connectionName === config.connectionName) {
      console.error(`Debug: Processing signal quality for ${connection.connectionName}`);
      console.error(`Debug: Available cellular fields:`, Object.keys(connection.cellularStatus));
      
      // Extract signal values from cellularStatus
      const rssi = connection.cellularStatus.rssi;
      const sinr = connection.cellularStatus.sinr;
      const rsrp = connection.cellularStatus.rsrp;
      const rsrq = connection.cellularStatus.rsrq;
      
      console.error(`Debug: Signal values - RSSI: ${rssi}, SINR: ${sinr}, RSRP: ${rsrp}, RSRQ: ${rsrq}`);
      
      if (rssi && sinr && rsrp && rsrq) {
        const signalQuality = calculateSignalQuality(rssi, sinr, rsrp, rsrq);
        console.error(`Debug: Calculated signal quality: ${signalQuality}`);
        connection.cellularStatus.signalQuality = signalQuality;
      } else {
        console.error(`Debug: Missing signal values, cannot calculate quality`);
      }
    }
  });

  return wanConnections;
}

// Execute SSH command using ssh2 library
async function executeSSHCommand() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let connectionClosed = false;
    
    // Set up timeout to ensure connection doesn't hang
    const timeout = setTimeout(() => {
      if (!connectionClosed) {
        connectionClosed = true;
        conn.end();
        reject(new Error('SSH connection timeout'));
      }
    }, 30000); // 30 second timeout
    
    conn.on('ready', () => {
      conn.shell((err, stream) => {
        if (err) {
          clearTimeout(timeout);
          connectionClosed = true;
          conn.end();
          reject(err);
          return;
        }

        let output = '';
        let commandSent = false;
        let capturing = false;

        stream.on('close', () => {
          clearTimeout(timeout);
          if (!connectionClosed) {
            connectionClosed = true;
            conn.end();
            
            // Extract just the 'get wan' output
            const lines = output.split('\n');
            const startIndex = lines.findIndex(line => line.includes('WAN Connection'));
            
            if (startIndex !== -1) {
              const endIndex = lines.findIndex((line, index) => 
                index > startIndex && line.includes('>') && !line.includes('WAN Connection')
              );
              
              const cleanOutput = lines.slice(startIndex, endIndex !== -1 ? endIndex : undefined)
                .filter(line => line.trim() && !line.includes('>'))
                .join('\n');
              
              resolve(cleanOutput);
            } else {
              reject(new Error('No WAN connection data found in output'));
            }
          }
        });

        stream.on('data', (data) => {
          const text = data.toString();
          output += text;
          
          // Wait for the prompt and send command
          if (!commandSent && text.includes('>')) {
            stream.write('get wan\n');
            commandSent = true;
            capturing = true;
          } else if (commandSent && capturing && text.includes('>')) {
            // Command finished, exit gracefully
            stream.write('exit\n');
          }
        });

        stream.on('error', (err) => {
          clearTimeout(timeout);
          if (!connectionClosed) {
            connectionClosed = true;
            conn.end();
            reject(new Error(`SSH stream error: ${err.message}`));
          }
        });

        stream.stderr.on('data', (data) => {
          clearTimeout(timeout);
          if (!connectionClosed) {
            connectionClosed = true;
            conn.end();
            reject(new Error(`SSH stderr: ${data}`));
          }
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeout);
      if (!connectionClosed) {
        connectionClosed = true;
        conn.end();
        reject(new Error(`SSH connection error: ${err.message}`));
      }
    });

    conn.on('end', () => {
      clearTimeout(timeout);
      connectionClosed = true;
    });

    conn.on('close', () => {
      clearTimeout(timeout);
      connectionClosed = true;
    });

    // Connect to SSH
    conn.connect({
      host: config.host,
      port: parseInt(config.port),
      username: config.username,
      password: config.password,
      readyTimeout: 30000,
      keepaliveInterval: 0, // Disable keepalive since we're doing quick operations
      keepaliveCountMax: 0
    });
  });
}

// Main execution
async function main() {
  try {
    if (!config.password) {
      throw new Error('PEPLINK_PASSWORD environment variable is required');
    }
    if (!config.host) {
      throw new Error('PEPLINK_HOST environment variable is required');
    }
    if (!config.connectionName) {
      throw new Error('PEPLINK_CONNECTION environment variable is required');
    }

    console.error(`Debug: Looking for connection named "${config.connectionName}"`);
    
    const rawOutput = await executeSSHCommand();
    console.error('Debug: Raw SSH output received');
    
    const wanData = parseWanOutput(rawOutput);
    console.error(`Debug: Parsed ${wanData.length} WAN connections:`);
    
    // Debug: Show all connections found
    wanData.forEach((conn, index) => {
      console.error(`  Connection ${index + 1}: "${conn.connectionName}" (${conn.connectionType}) - Status: ${conn.connectionStatus}`);
      if (conn.cellularStatus) {
        console.error(`    Has cellular data: RSSI=${conn.cellularStatus.rssi}, SignalQuality=${conn.cellularStatus.signalQuality}`);
      }
    });
    
    // Find the target connection
    const targetConnection = wanData.find(conn => 
      conn.connectionName === config.connectionName && 
      conn.connectionType === 'Cellular' && 
      conn.cellularStatus
    );
    
    if (!targetConnection) {
      console.error(`Debug: No connection found matching name "${config.connectionName}" with type "Cellular" and cellular status`);
      
      // Try without cellular type requirement
      const anyConnection = wanData.find(conn => conn.connectionName === config.connectionName);
      if (anyConnection) {
        console.error(`Debug: Found connection "${config.connectionName}" but it's type "${anyConnection.connectionType}" not "Cellular"`);
      } else {
        console.error(`Debug: No connection found with name "${config.connectionName}" at all`);
        console.error('Available connection names:', wanData.map(c => `"${c.connectionName}"`).join(', '));
      }
    }
    
    if (targetConnection && targetConnection.cellularStatus && targetConnection.cellularStatus.signalQuality) {
      // Convert percentage to ratio (0.0 to 1.0) for SignalK
      const percentageValue = parseFloat(targetConnection.cellularStatus.signalQuality.replace('%', ''));
      const signalQualityRatio = percentageValue / 100;
      
      console.error(`Debug: Found signal quality ${targetConnection.cellularStatus.signalQuality} -> ${signalQualityRatio}`);
      
      // Output just the signal quality value as a number
      console.log(signalQualityRatio.toFixed(3));
    } else {
      // No cellular connection found or no signal quality available
      console.error('Debug: No signal quality data available');
      console.log('null');
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();