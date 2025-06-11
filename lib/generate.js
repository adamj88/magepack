const puppeteer = require('puppeteer');
const { stringify } = require('javascript-stringify');
const fs = require('fs');
const path = require('path');

const logger = require('./utils/logger');
const collectors = require('./generate/collector');
const extractCommonBundle = require('./generate/extractCommonBundle');

const withTimeout = (promise, ms, operation) => {
    let timeoutId;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const timeoutError = new Error(
                `⏰ TIMEOUT: ${operation} exceeded ${Math.round(
                    ms / 1000
                )}s limit`
            );
            timeoutError.isTimeout = true;
            reject(timeoutError);
        }, ms);
    });

    const wrappedPromise = promise.finally(() => {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    });

    return Promise.race([wrappedPromise, timeout]);
};

// Memory monitoring helper
const getMemoryUsage = () => {
    const usage = process.memoryUsage();
    return {
        rss: Math.round(usage.rss / 1024 / 1024),
        heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
        external: Math.round(usage.external / 1024 / 1024),
    };
};

// Force garbage collection if available
const forceGC = () => {
    if (global.gc) {
        global.gc();
        logger.debug(`Memory after GC: ${JSON.stringify(getMemoryUsage())} MB`);
    }
};

// Memory limit check (default 6GB)
const checkMemoryLimit = (limitMB = 6144) => {
    const usage = getMemoryUsage();
    if (usage.rss > limitMB) {
        throw new Error(
            `Memory limit exceeded: ${usage.rss}MB > ${limitMB}MB. Consider reducing parallel operations or increasing memory limit.`
        );
    }
    return usage;
};

// Page pool for reusing browser pages
class PagePool {
    constructor(browserContext, maxPages = 3) {
        this.browserContext = browserContext;
        this.maxPages = maxPages;
        this.availablePages = [];
        this.usedPages = new Set();
        this.pageCounter = 0;
    }

    async getPage() {
        // Try to reuse an available page
        if (this.availablePages.length > 0) {
            const page = this.availablePages.pop();
            this.usedPages.add(page);
            logger.debug(
                `Reusing page ${page._pageId}. Pool: ${this.availablePages.length} available, ${this.usedPages.size} in use`
            );

            // Clean up the page for reuse (only for reused pages)
            try {
                await this.cleanupPage(page);
                return page;
            } catch (error) {
                logger.debug(
                    `Failed to cleanup reused page ${page._pageId}, creating new one`
                );
                // Remove the corrupted page from tracking
                this.usedPages.delete(page);
                await this.disposePage(page);
                // Fall through to create a new page
            }
        }

        // Create new page if under limit
        if (this.usedPages.size < this.maxPages) {
            const page = await this.browserContext.newPage();
            page._pageId = ++this.pageCounter;
            this.usedPages.add(page);
            logger.debug(
                `Created new page ${page._pageId}. Pool: ${this.availablePages.length} available, ${this.usedPages.size} in use`
            );
            return page;
        }

        // Pool is full, wait for a page to be released
        throw new Error(
            `Page pool exhausted. Maximum ${this.maxPages} pages in use.`
        );
    }

    async releasePage(page) {
        if (!this.usedPages.has(page)) {
            logger.warn(
                `Attempting to release page ${page._pageId} that is not in use`
            );
            return;
        }

        this.usedPages.delete(page);

        // Check if page is still valid
        if (page.isClosed()) {
            logger.debug(
                `Page ${page._pageId} was closed, not returning to pool`
            );
            return;
        }

        // Clean up and return to pool
        try {
            await this.cleanupPage(page);
            this.availablePages.push(page);
            logger.debug(
                `Released page ${page._pageId} to pool. Pool: ${this.availablePages.length} available, ${this.usedPages.size} in use`
            );
        } catch (error) {
            logger.warn(
                `Failed to clean up page ${page._pageId}: ${error.message}`
            );
            await this.disposePage(page);
        }
    }

    async cleanupPage(page) {
        // Check if page is still valid before cleanup
        if (page.isClosed()) {
            logger.debug(
                `Page ${page._pageId} is already closed, skipping cleanup`
            );
            return;
        }

        try {
            // Clear any existing navigation timeouts
            await page.setDefaultNavigationTimeout(0);

            // Navigate to blank page to clear state
            await page.goto('about:blank', {
                waitUntil: 'domcontentloaded',
                timeout: 5000,
            });

            // Clear cookies and storage
            await page.evaluate(() => {
                try {
                    // Clear localStorage and sessionStorage
                    if (typeof Storage !== 'undefined') {
                        try {
                            localStorage.clear();
                        } catch (e) {
                            // localStorage access denied, skip
                        }
                        try {
                            sessionStorage.clear();
                        } catch (e) {
                            // sessionStorage access denied, skip
                        }
                    }

                    // Clear any global variables that might leak
                    if (window.require) {
                        // Don't fully clear require as we need it, but clear contexts
                        if (window.require.s && window.require.s.contexts) {
                            Object.keys(window.require.s.contexts).forEach(
                                (contextName) => {
                                    if (contextName !== '_') {
                                        delete window.require.s.contexts[
                                            contextName
                                        ];
                                    }
                                }
                            );
                        }
                    }
                } catch (error) {
                    // Ignore cleanup errors
                }
            });

            // Clear all request interceptors and event listeners
            page.removeAllListeners();

            logger.debug(`Successfully cleaned up page ${page._pageId}`);
        } catch (error) {
            logger.debug(
                `Failed to clean up page ${page._pageId}: ${error.message}`
            );
            // If cleanup fails, the page is likely corrupted and should be disposed
            throw error;
        }
    }

    async disposePage(page) {
        try {
            if (!page.isClosed()) {
                await page.close();
            }
        } catch (error) {
            logger.debug(`Error disposing page: ${error.message}`);
        }
    }

    async destroy() {
        // Close all pages in the pool
        const allPages = [...this.availablePages, ...this.usedPages];
        await Promise.all(allPages.map((page) => this.disposePage(page)));
        this.availablePages = [];
        this.usedPages.clear();
        logger.debug(`Page pool destroyed. Closed ${allPages.length} pages.`);
    }
}

module.exports = async (generationConfig) => {
    const overallTimeout = generationConfig.timeout
        ? parseInt(generationConfig.timeout) * 5
        : 1800000; // 30 minutes default, or 5x page timeout

    logger.info(
        `Starting generation. Initial memory: ${JSON.stringify(
            getMemoryUsage()
        )} MB`
    );

    const browser = await puppeteer.launch({
        headless: !generationConfig.debug,
        args: [
            // Essential flags only
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--max_old_space_size=8192',
        ],
        defaultViewport: { width: 412, height: 732 },
        ignoreHTTPSErrors: true,
        timeout: 30000, // Browser launch timeout
    });

    let browserContext;
    let pagePool;
    let bundles = [];

    // Handle process termination signals for graceful cleanup
    const cleanup = async (signal) => {
        logger.warn(`Received ${signal}. Cleaning up browser resources...`);
        if (pagePool) {
            try {
                await pagePool.destroy();
            } catch (e) {
                logger.debug('Failed to destroy page pool during cleanup');
            }
        }
        if (browserContext) {
            try {
                await browserContext.close();
            } catch (e) {
                logger.debug('Failed to close browser context during cleanup');
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                logger.debug('Failed to close browser during cleanup');
            }
        }
        process.exit(1);
    };

    // Register cleanup handlers
    process.once('SIGINT', () => cleanup('SIGINT'));
    process.once('SIGTERM', () => cleanup('SIGTERM'));
    process.once('SIGHUP', () => cleanup('SIGHUP'));

    try {
        browserContext = await browser.createIncognitoBrowserContext();

        // Initialize page pool
        pagePool = new PagePool(browserContext, 3); // Max 3 concurrent pages
        logger.info('Initialized page pool with 3 pages maximum');

        if (generationConfig.skipCheckout) {
            delete collectors['checkout'];
        }

        logger.info('Collecting bundle modules in the browser.');

        // Wrap entire collection process in timeout
        const collectionPromise = async () => {
            const bundles = [];
            const collectorNames = Object.keys(collectors);
            const totalCollectors = collectorNames.length;
            let currentCollector = 0;

            for (const collectorName of collectorNames) {
                currentCollector++;
                logger.info(
                    `📦 [${currentCollector}/${totalCollectors}] Starting collection for ${collectorName}...`
                );

                // Check memory before each collector
                const memoryBefore = checkMemoryLimit();
                logger.debug(
                    `Memory before ${collectorName}: ${JSON.stringify(
                        memoryBefore
                    )} MB`
                );

                try {
                    const result = await withTimeout(
                        collectors[collectorName](
                            browserContext,
                            generationConfig,
                            pagePool
                        ),
                        generationConfig.timeout
                            ? parseInt(generationConfig.timeout)
                            : 300000, // 5 minutes default
                        `${collectorName} collector`
                    );
                    bundles.push(result);

                    // Force garbage collection after each collector
                    forceGC();

                    const memoryAfter = getMemoryUsage();
                    logger.success(
                        `Completed collection for ${collectorName}. Memory: ${JSON.stringify(
                            memoryAfter
                        )} MB`
                    );

                    // Force flush logs in real-time
                    if (process.stdout.isTTY) {
                        process.stdout.write(''); // Trigger flush
                    }
                } catch (error) {
                    // Log error immediately with full details
                    logger.error(`❌ FAILED: ${collectorName} collector`);
                    logger.error(`Error: ${error.message}`);

                    if (generationConfig.debug && error.stack) {
                        logger.error(`Stack trace:\n${error.stack}`);
                    }

                    // Force flush error output immediately
                    if (process.stderr.isTTY) {
                        process.stderr.write(''); // Trigger flush
                    }

                    // Add current memory usage to error context
                    const errorMemory = getMemoryUsage();
                    logger.error(
                        `Memory at failure: ${JSON.stringify(errorMemory)} MB`
                    );

                    throw error;
                }
            }
            return bundles;
        };

        bundles = await withTimeout(
            collectionPromise(),
            overallTimeout,
            'Overall generation process'
        );

        logger.info('Extracting common module...');

        bundles = extractCommonBundle(bundles);

        logger.success('Done, outputting following modules:');

        bundles.forEach((bundle) => {
            logger.success(
                `${bundle.name} - ${Object.keys(bundle.modules).length} items.`
            );
        });

        fs.writeFileSync(
            path.resolve('magepack.config.js'),
            `module.exports = ${stringify(bundles, null, '  ')}`
        );

        const finalMemory = getMemoryUsage();
        logger.info(
            `Generation completed successfully. Final memory: ${JSON.stringify(
                finalMemory
            )} MB`
        );
    } catch (error) {
        const errorMemory = getMemoryUsage();
        logger.error(
            `Generation failed: ${
                error.message
            }. Memory at failure: ${JSON.stringify(errorMemory)} MB`
        );
        throw error;
    } finally {
        // Remove signal handlers to prevent memory leaks
        process.removeAllListeners('SIGINT');
        process.removeAllListeners('SIGTERM');
        process.removeAllListeners('SIGHUP');

        // Destroy page pool first
        if (pagePool) {
            try {
                await pagePool.destroy();
            } catch (e) {
                logger.warn('Failed to destroy page pool');
            }
        }

        // Ensure browser is always closed
        if (browserContext) {
            try {
                await browserContext.close();
            } catch (e) {
                logger.warn('Failed to close browser context');
            }
        }
        if (browser) {
            try {
                await browser.close();
            } catch (e) {
                logger.warn('Failed to close browser');
            }
        }

        // Final cleanup
        forceGC();
        logger.info('Finished, closing the browser.');
    }
};
