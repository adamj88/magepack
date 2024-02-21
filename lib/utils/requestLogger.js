const logger = require('./logger');

class RequestLogger {
    constructor(page) {
        this.consoleLog = [];

        page.on('console', (message) => {
            this.consoleLog.push(
                `${message.type().substr(0, 3).toUpperCase()} ${message.text()}`
            );
        })
            .on('pageerror', ({ message }) => {
                this.consoleLog.push(message);
            })
            .on('response', (response) => {
                this.consoleLog.push(`${response.status()} ${response.url()}`);
            })
            .on('requestfailed', (request) => {
                this.consoleLog.push(
                    `${request.failure().errorText} ${request.url()}`
                );
            });
    }

    output(bundleName) {
        logger.error(`${bundleName} page was terminated.`);

        for (var index in this.consoleLog) {
            var entry = this.consoleLog[index].toString();

            if (entry.indexOf('media/catalog/product') > -1) {
                continue;
            }

            logger.log(this.consoleLog[index]);
        }
    }
}

module.exports = RequestLogger;
