import app from './app';

// Set port from environment variable or default to 3003
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3003;

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});
