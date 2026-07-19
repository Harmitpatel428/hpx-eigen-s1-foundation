import app from './app';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[HPX Eigen S1] Server running on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
});
