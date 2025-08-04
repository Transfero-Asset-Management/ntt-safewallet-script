import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { bridgeRoutes } from './routes/bridge.routes';
import { statusRoutes } from './routes/status.routes';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'brz-ntt-bridge',
    timestamp: new Date().toISOString() 
  });
});

// Routes
app.use('/api/bridge', bridgeRoutes);
app.use('/api/status', statusRoutes);

// Error handling middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
});

// Start server - explicitly listen on all IPv4 interfaces
app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`BRZ NTT Bridge Service running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Listening on: 0.0.0.0:${PORT}`);
  
  // Check required environment variables
  if (!process.env.ETH_PRIVATE_KEY) {
    console.warn('WARNING: ETH_PRIVATE_KEY not set in environment');
  }
});