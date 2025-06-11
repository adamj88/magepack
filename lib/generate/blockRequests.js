const logger = require('../utils/logger');

/**
 * @param {Page} page Puppeteer Page object instance.
 */
const blockRequests = (page) => {
    page.setRequestInterception(true);
    page.on('request', (request) => {
        const url = request.url();

        // If we let these resources load, 'magepack generate' hangs at rjsResolver step.
        if (url.match(/magepack\/requirejs-config-.*\.js$/)) {
            logger.info('Blocked resource: ' + url);
            request.abort();
            return;
        }

        // Block third party scripts preventing networkidle0
        if (url.includes('googletagmanager.com')) {
            logger.info('Blocked resource: ' + url);
            request.abort();
            return;
        }

        if (url.includes('app.termly.io')) {
            logger.info('Blocked resource: ' + url);
            request.abort();
            return;
        }

        request.continue();
    });
};

module.exports = blockRequests;
