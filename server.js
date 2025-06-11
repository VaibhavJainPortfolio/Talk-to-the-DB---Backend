// server.js - Backend API for chatbot (Vercel compatible)
const express = require('express');
const cors = require('cors');
const sql = require('mssql');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  credentials: true
}));
app.use(express.json());

// SQL Server configuration
const sqlConfig = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  server: process.env.DB_SERVER,
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000
  },
  options: {
    encrypt: true,
    trustServerCertificate: true
  }
};

// Claude API configuration
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

// Database connection function for serverless
async function getDatabaseConnection() {
  try {
    const pool = await sql.connect(sqlConfig);
    return pool;
  } catch (err) {
    console.error('Database connection failed:', err);
    throw err;
  }
}

// Endpoint to get available tables
app.get('/api/tables', async (req, res) => {
  let pool;
  try {
    pool = await getDatabaseConnection();
    const result = await pool.request()
      .query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'");
    res.json(result.recordset.map(row => row.TABLE_NAME));
  } catch (err) {
    console.error('Tables endpoint error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (closeErr) {
        console.error('Error closing pool:', closeErr);
      }
    }
  }
});

// Endpoint to get table schema
app.get('/api/tables/:tableName/schema', async (req, res) => {
  let pool;
  try {
    const { tableName } = req.params;
    pool = await getDatabaseConnection();
    const result = await pool.request()
      .input('tableName', sql.VarChar, tableName)
      .query(`
        SELECT 
          COLUMN_NAME,
          DATA_TYPE,
          IS_NULLABLE,
          COLUMN_DEFAULT
        FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = @tableName
        ORDER BY ORDINAL_POSITION
      `);
    res.json(result.recordset);
  } catch (err) {
    console.error('Schema endpoint error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (closeErr) {
        console.error('Error closing pool:', closeErr);
      }
    }
  }
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  let pool;
  try {
    const { message, conversationHistory = [] } = req.body;

    // Get database connection
    pool = await getDatabaseConnection();

    // Get list of available tables for context
    const tablesResult = await pool.request()
      .query("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE'");
    const availableTables = tablesResult.recordset.map(row => row.TABLE_NAME);

    // Prepare context for Claude
    const systemPrompt = `You are a helpful assistant that can query a SQL Server database. 
    Available tables: ${availableTables.join(', ')}
    
    When a user asks a question that requires database information:
    1. Generate the appropriate SQL query
    2. Return the query in a structured format so it can be executed
    3. Provide explanations for your responses
    
    Important: Only generate SELECT queries. Do not generate INSERT, UPDATE, DELETE, or DDL queries.
    
    Format your response as JSON with these fields:
    - needsQuery: boolean (true if SQL query is needed)
    - query: string (the SQL query if needed)
    - explanation: string (explanation of what you're doing)
    - response: string (your response to the user)`;

    // Call Claude API
    const claudeResponse = await axios.post(CLAUDE_API_URL, {
      model: 'claude-3-sonnet-20240229',
      max_tokens: 1000,
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },
        ...conversationHistory,
        {
          role: 'user',
          content: message
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${CLAUDE_API_KEY}`,
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY
      }
    });

    let claudeMessage = claudeResponse.data.content[0].text;
    let queryResult = null;

    // Try to parse Claude's response as JSON
    try {
      const parsedResponse = JSON.parse(claudeMessage);
      
      if (parsedResponse.needsQuery && parsedResponse.query) {
        // Execute the SQL query using the same pool connection
        const result = await pool.request().query(parsedResponse.query);
        queryResult = result.recordset;
        
        // Update the response with query results
        claudeMessage = `${parsedResponse.response}\n\nQuery Results:\n${JSON.stringify(queryResult, null, 2)}`;
      } else {
        claudeMessage = parsedResponse.response;
      }
    } catch (parseError) {
      // If parsing fails, use the raw response
      console.log('Could not parse Claude response as JSON, using raw response');
    }

    res.json({
      response: claudeMessage,
      queryResult: queryResult,
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.error('Chat endpoint error:', err);
    res.status(500).json({ error: 'Internal server error', details: err.message });
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (closeErr) {
        console.error('Error closing pool:', closeErr);
      }
    }
  }
});

// Execute custom SQL query (for testing)
app.post('/api/query', async (req, res) => {
  let pool;
  try {
    const { query } = req.body;
    
    // Basic security check - only allow SELECT queries
    if (!query.trim().toUpperCase().startsWith('SELECT')) {
      return res.status(400).json({ error: 'Only SELECT queries are allowed' });
    }

    pool = await getDatabaseConnection();
    const result = await pool.request().query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('Query endpoint error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch (closeErr) {
        console.error('Error closing pool:', closeErr);
      }
    }
  }
});

app.get('/', (req, res) => {
  res.send('Hello Worlds');
})

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// For Vercel deployment
module.exports = app;
