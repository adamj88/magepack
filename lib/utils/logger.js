const consola = require('consola');

const logger = consola.create({
    formatOptions: {
        date: true,
    },
    // Ensure immediate output without buffering
    async: false,
    stdout: process.stdout,
    stderr: process.stderr,
});

module.exports = logger;
