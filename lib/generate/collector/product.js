const merge = require('lodash.merge');
const path = require('path');

const logger = require('../../utils/logger');
const RequestLogger = require('../../utils/requestLogger');
const authenticate = require('../authenticate');
const collectModules = require('../collectModules');
const blockRequests = require('../blockRequests');

const baseConfig = {
    url: [],
    name: 'product',
    modules: {},
};

/**
 * Prepares a bundle configuration for all modules loaded on product pages.
 *
 * @param {BrowserContext} browserContext Puppeteer's BrowserContext object.
 * @param {object} configuration Generation configuration object.
 * @param {string} configuration.productUrl URL to the product page.
 * @param {string} configuration.authUsername Basic auth username.
 * @param {string} configuration.authPassword Basic auth password.
 * @param {int} configuration.timeout Page navigation timeout.
 */
const product = async (
    browserContext,
    {
        productUrl,
        authUsername,
        authPassword,
        timeout,
        screenshot,
        screenshotPath,
        excludedModules,
    },
    pagePool = null
) => {
    let page;
    let requestLogger;
    let bundleName;

    try {
        const bundleConfig = merge({}, baseConfig);

        bundleName = bundleConfig.name;

        logger.info(`Collecting modules for bundle "${bundleName}".`);

        if (!productUrl) {
            logger.info(
                `No URL configured for bundle "${bundleName}" - skipping.`
            );
            return bundleConfig;
        }

        // Use page pool if available, otherwise create new page
        if (pagePool) {
            page = await pagePool.getPage();
            logger.debug(`Using pooled page ${page._pageId} for ${bundleName}`);
        } else {
            page = await browserContext.newPage();
            logger.debug(`Created new page for ${bundleName}`);
        }

        requestLogger = new RequestLogger(page);

        blockRequests(page);

        timeout && (await page.setDefaultNavigationTimeout(timeout));

        await authenticate(page, authUsername, authPassword);

        await page.goto(productUrl, {
            waitUntil: 'networkidle0',
            timeout: timeout || 120000,
        });

        if (screenshot) {
            await page.screenshot({
                path: path.join(screenshotPath, `magepack-${bundleName}.png`),
                fullPage: true,
            });
        }

        merge(
            bundleConfig.modules,
            await collectModules(page, excludedModules)
        );

        // Return page to pool or close it
        if (pagePool && page) {
            await pagePool.releasePage(page);
            logger.debug(`Released page ${page._pageId} back to pool`);
        } else if (page) {
            await page.close();
        }

        logger.success(
            `Finished collecting modules for bundle "${bundleName}".`
        );

        return bundleConfig;
    } catch (e) {
        if (requestLogger) {
            requestLogger.output(bundleName);
        }

        // Clean up page on error
        if (pagePool && page) {
            await pagePool.releasePage(page);
            logger.debug(
                `Released page ${page._pageId} back to pool after error`
            );
        } else if (page && !page.isClosed()) {
            await page.close();
        }

        throw e;
    }
};

module.exports = product;
