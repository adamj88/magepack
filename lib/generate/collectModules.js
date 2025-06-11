/* eslint-env browser */

const staticExcludedModules = require('./excludedModules');
const logger = require('../utils/logger');

/**
 * Collects all defined RequireJS modules on a given page.
 */
module.exports = async (page, excModules) => {
    var excludedModules = staticExcludedModules;

    if (excModules) {
        excModules = excModules.split(',');
        excludedModules = staticExcludedModules.concat(excModules);
    }

    /**
     * Log console messages with proper real-time streaming
     */
    page.on('console', (message) => {
        const text = message.text();
        const type = message.type().toUpperCase();

        // Use logger instead of console.log for proper streaming
        logger.info(`${type} ${text}`);

        // Force flush for real-time output
        if (process.stdout.isTTY) {
            process.stdout.write('');
        }
    })
        .on('pageerror', ({ message }) => {
            logger.error(`PAGE ERROR: ${message}`);

            // Force flush for real-time output
            if (process.stderr.isTTY) {
                process.stderr.write('');
            }
        })
        .on('requestfailed', (request) => {
            logger.warn(
                `REQUEST FAILED: ${
                    request.failure().errorText
                } ${request.url()}`
            );

            // Force flush for real-time output
            if (process.stderr.isTTY) {
                process.stderr.write('');
            }
        });

    /**
     * Wait to make sure RequireJS is loaded.
     */
    await page.waitForFunction(
        () => {
            return window.require;
        },
        { timeout: 30000 }
    );

    /**
     * Use Magento's rjsResolver to wait for all modules to load.
     */
    await page.evaluate(() => {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('rjsResolver timeout'));
            }, 120000); // 2 minutes timeout

            require(['rjsResolver'], function (resolver) {
                resolver(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            });
        });
    });

    /**
     * Wait for browser to be idle for a good measure.
     */
    await page.evaluate(() => {
        return new Promise((resolve) => {
            const timeout = setTimeout(resolve, 10000); // 10s fallback
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(() => {
                    clearTimeout(timeout);
                    resolve();
                });
            } else {
                // Fallback if requestIdleCallback is not available
                setTimeout(resolve, 2000);
            }
        });
    });

    /**
     * Wait another 5s for a good measure.
     */
    await page.waitFor(5000);

    const modules = await page.evaluate((excludedModules) => {
        function extractBaseUrl(require) {
            const baseUrl = require.toUrl('');
            return baseUrl.replace(/\/[^/]+\/[^/]+\/[^/]+\/[^/]+\/$/, '/');
        }

        function stripBaseUrl(baseUrl, moduleUrl) {
            if (!moduleUrl.startsWith(baseUrl)) {
                return moduleUrl;
            }

            return moduleUrl
                .substring(baseUrl.length)
                .replace(/^[^/]+\/[^/]+\/[^/]+\/[^/]+\//, '');
        }

        const stripPlugin = (moduleName) => moduleName.replace(/^[^!].+!/, '');

        const baseUrl = extractBaseUrl(require);

        const contexts = require.s.contexts;
        const defContext = contexts._;
        const defaultContextConfig = defContext.config;
        const unbundledContextConfig = {
            baseUrl: defaultContextConfig.baseUrl,
            paths: defaultContextConfig.paths,
            shim: defaultContextConfig.shim,
            config: defaultContextConfig.config,
            map: defaultContextConfig.map,
        };
        const unbundledContext = require.s.newContext('magepack');

        /**
         * Prepare a separate context where modules are not assigned to bundles.
         * This make it possible to fetch real module paths even with bundling enabled.
         */
        unbundledContext.configure(unbundledContextConfig);

        const modules = {};
        Object.keys(window.require.s.contexts._.defined).forEach(
            (moduleName) => {
                /**
                 * Ignore all modules that are loaded with plugins other than text.
                 */
                if (
                    (moduleName.includes('!') &&
                        !moduleName.startsWith('text!')) ||
                    moduleName.match(/^(https?:)?\/\//)
                ) {
                    return;
                }

                /**
                 * Ignore excluded modules.
                 */
                if (excludedModules.includes(moduleName)) {
                    return;
                }

                /**
                 * Get module path from resolved url
                 */
                modules[moduleName] = stripBaseUrl(
                    baseUrl,
                    unbundledContext.require.toUrl(stripPlugin(moduleName))
                );

                if (
                    Object.prototype.hasOwnProperty.call(
                        window.require.s.contexts._.config.config.mixins,
                        moduleName
                    )
                ) {
                    for (const [mixinModuleName, enabled] of Object.entries(
                        window.require.s.contexts._.config.config.mixins[
                            moduleName
                        ]
                    )) {
                        if (enabled) {
                            modules[mixinModuleName] = stripBaseUrl(
                                baseUrl,
                                unbundledContext.require.toUrl(
                                    stripPlugin(mixinModuleName)
                                )
                            );
                        }
                    }
                }
            }
        );

        return modules;
    }, excludedModules);

    return modules;
};
