module.exports = {
  apps: [
    {
      name: 'muse',
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
      },
      watch: false,
      interpreter: 'node@20.17.0', // Update this to match your Node version
      autorestart: true,
    },
  ],
}
