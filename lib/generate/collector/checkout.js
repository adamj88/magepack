/* global BASE_URL */

const merge = require('lodash.merge');
const path = require('path');

const logger = require('../../utils/logger');
const RequestLogger = require('../../utils/requestLogger');
const authenticate = require('../authenticate');
const collectModules = require('../collectModules');
const blockRequests = require('../blockRequests');

const baseConfig = {
    url: {},
    name: 'checkout',
    modules: {},
};

/**
 * Prepares a bundle configuration for all modules loaded on cart and checkout pages.
 *
 * @param {BrowserContext} browserContext Puppeteer's BrowserContext object.
 * @param {object} configuration Generation configuration object.
 * @param {string} configuration.productUrl URL to the product page.
 * @param {string} configuration.authUsername Basic auth username.
 * @param {string} configuration.authPassword Basic auth password.
 * @param {int} configuration.timeout Page navigation timeout.
 */
const checkout = async (
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
                path: path.join(
                    screenshotPath,
                    `magepack-${bundleName}-product.png`
                ),
                fullPage: true,
            });
        }

        // Select option for every swatch if there are any.
        await page.evaluate(() => {
            const swatches = document.querySelectorAll(
                '.product-options-wrapper .swatch-attribute'
            );
            Array.from(swatches).forEach((swatch) => {
                const swatchOption = swatch.querySelector(
                    '.swatch-option:not([disabled])'
                );
                swatch.querySelector('.swatch-input').value =
                    swatchOption.getAttribute('option-id') ||
                    swatchOption.getAttribute('data-option-id');
            });

            if (swatches.length) {
                return;
            }

            Array.from(
                document.querySelectorAll(
                    '.product-options-wrapper .super-attribute-select'
                )
            ).forEach((select) => {
                select.value = Array.from(select.options).reduce(
                    (selectedValue, option) => {
                        return (
                            selectedValue ||
                            (option.value ? option.value : selectedValue)
                        );
                    },
                    null
                );

                select.dispatchEvent(new Event('input', { bubbles: true }));
                select.dispatchEvent(new Event('change', { bubbles: true }));
            });
        });

        await Promise.all([
            page.waitForNavigation({
                waitUntil: 'networkidle0',
                timeout: timeout || 120000,
            }),
            page.evaluate(() =>
                document.querySelector('#product_addtocart_form').submit()
            ),
        ]);

        const baseUrl = await page.evaluate(() => BASE_URL);

        await page.goto(`${baseUrl}checkout/cart`, {
            waitUntil: 'networkidle0',
            timeout: timeout || 120000,
        });

        if (screenshot) {
            await page.screenshot({
                path: path.join(
                    screenshotPath,
                    `magepack-${bundleName}-cart.png`
                ),
                fullPage: true,
            });
        }

        const cartModules = await collectModules(page, excludedModules);

        await page.goto(`${baseUrl}checkout`, {
            waitUntil: 'networkidle0',
            timeout: timeout || 120000,
        });

        if (screenshot) {
            await page.screenshot({
                path: path.join(screenshotPath, `magepack-${bundleName}.png`),
                fullPage: true,
            });
        }

        const checkoutModules = await collectModules(page, excludedModules);

        merge(bundleConfig.modules, cartModules, checkoutModules);

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

module.exports = checkout;
