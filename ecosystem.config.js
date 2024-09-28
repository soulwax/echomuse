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
      interpreter: 'node@20.17.0', // Specify the Node.js version
      autorestart: true,
    },
  ],
}
