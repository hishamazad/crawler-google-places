// @ts-nocheck
/* eslint-disable object-property-newline */
const Apify = require('apify');

const placesCrawler = require('./places_crawler');
const resultJsonSchema = require('./result_item_schema');
const { Stats } = require('./stats');
const { prepareSearchUrls } = require('./search');
const { createStartRequestsWithWalker } = require('./walker');
const { makeInputBackwardsCompatible, validateInput } = require('./input-validation');

const cachedPlacesName = 'Places-cached-locations';

const { log } = Apify.utils;

Apify.main(async () => {
    const input = await Apify.getValue('INPUT');
    const stats = new Stats(300);

    makeInputBackwardsCompatible(input);
    validateInput(input);

    const {
        // Search and Start URLs
        startUrls, searchStringsArray,
        // Localization
        lat, lng, country, state, city, zoom = 10,
        // browser and request options
        pageLoadTimeoutSec = 60, useChrome = false, maxConcurrency, maxPagesPerBrowser = 1, maxPageRetries = 6,
        // Misc
        proxyConfig, regularTestRun, debug, language = 'en', useStealth,
        // walker is undocumented feature added by jakubdrobnik, we need to test it and document it
        walker,

        // Scraping options
        includeHistogram = false, includeOpeningHours = false, includePeopleAlsoSearch = false, maxImages, exportPlaceUrls = false, additionalInfo = false, maxCrawledPlaces,
        maxAutomaticZoomOut, cachePlaces = false,
    } = input;

    const scrapingOptions = {
        includeHistogram, includeOpeningHours, includePeopleAlsoSearch, maxImages, exportPlaceUrls, additionalInfo, maxCrawledPlaces,
        maxAutomaticZoomOut, cachePlaces, language,
    };

    if (debug) {
        log.setLevel(log.LEVELS.DEBUG);
    }

    let allPlaces = {};
    if (cachePlaces) {
        log.debug('Load cached places');
        const allPlacesStore = await Apify.openKeyValueStore(cachedPlacesName);
        allPlaces = await allPlacesStore.getValue('places') || {};
        log.debug('allPlaces', allPlaces);
        Apify.events.on('migrating', async () => {
            log.debug('Saving places before migration');
            const reloadedPlaces = (await allPlacesStore.getValue('places')) || {};
            // @ts-ignore
            const newPlaces = { ...allPlaces, ...reloadedPlaces };
            await allPlacesStore.setValue('places', newPlaces);
        });
    }

    // Requests that are used in the queue
    const startRequests = [];

    // Start URLs have higher preference than search
    if (Array.isArray(startUrls) && startUrls.length > 0) {
        if (searchStringsArray) {
            log.warning('\n\n------\nUsing Start URLs disables search. You can use either search or Start URLs.\n------\n');
        }
        const rlist = await Apify.openRequestList('STARTURLS', startUrls);
        let req;
        while (req = await rlist.fetchNextRequest()) { // eslint-disable-line no-cond-assign
            if (!req.url) {
                log.warning(`There is no valid URL for this request:`);
                console.dir(req);
            } else if (req.url.startsWith('https://www.google.com/search')) {
                log.warning('ATTENTION! URLs starting with "https://www.google.com/search" are not supported! Please transform your URL to start with "https://www.google.com/maps"');
                log.warning(`Happened for provided URL: ${req.url}`);
            } else if (!/www\.google\.com\/maps\/(search|place)\//.test(req.url) ) {
                // allows only search and place urls
                log.warning('ATTENTION! URL you provided is not recognized as a valid Google Maps URL. Please use URLs with /maps/search or /maps/place or contact support@apify.com to add a new format');
                log.warning(`Happened for provided URL: ${req.url}`);
            } else {
                // The URL is correct
                startRequests.push({
                    ...req,
                    userData: { label: 'startUrl', searchString: null },
                });
            }
        }
    } else if (searchStringsArray) {
        for (const searchString of searchStringsArray) {
            // TODO: walker is not documented!!! We should figure out if it is useful at all
            if (walker) {
                const walkerGeneratedRequests = createStartRequestsWithWalker({ walker, searchString });
                for (const req of walkerGeneratedRequests) {
                    startRequests.push(req);
                }
            } else if (searchString.includes('place_id:')) {
                /**
                 * User can use place_id:<Google place ID> as search query
                 * TODO: Move place id to separate fields, once we have dependent fields. Than user can fill placeId or search query.
                 */
                log.info(`Place ID found in search query. We will extract data from ${searchString}.`);
                const cleanSearch = searchString.replace(/\s+/g, '');
                const placeId = cleanSearch.match(/place_id:(.*)/)[1];
                startRequests.push({
                    url: `https://www.google.com/maps/search/?api=1&query=${cleanSearch}&query_place_id=${placeId}`,
                    uniqueKey: placeId,
                    userData: { label: 'detail', searchString },
                });
            } else {
                // This call is async because it persists a state into KV
                const { startUrlSearches, geo } = await prepareSearchUrls({ lat, lng, zoom, country, state, city });
                for (const startUrlSearch of startUrlSearches) {
                    startRequests.push({
                        url: startUrlSearch,
                        uniqueKey: `${startUrlSearch}+${searchString}`,
                        userData: { label: 'startUrl', searchString, geo },
                    });
                }
            }
        }
    }

    await stats.loadInfo();
    log.info('Start urls are:');
    console.dir(startRequests.map((r) => r.url));

    const requestQueue = await Apify.openRequestQueue();

    for (const request of startRequests) {
        await requestQueue.addRequest(request);
    }

    /**
     * @type {Apify.PuppeteerPoolOptions}}
     */
    const puppeteerPoolOptions = {
        useIncognitoPages: true,
        maxOpenPagesPerInstance: maxPagesPerBrowser,
    };

    const proxyConfiguration = await Apify.createProxyConfiguration(proxyConfig);

    /**
     * @type {Apify.PuppeteerCrawlerOptions}
     */
    const crawlerOptions = {
        requestQueue,
        // @ts-ignore
        proxyConfiguration,
        puppeteerPoolOptions,
        maxConcurrency,
        launchPuppeteerFunction: (options) => {
            return Apify.launchPuppeteer({
                ...options,
                // @ts-ignore
                headless: !useChrome,
                useChrome,
                args: [
                    // @ts-ignore
                    ...(options.args ? options.args : {}),
                    // this is needed to access cross-domain iframes
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins,site-per-process',
                    `--lang=${language}`, // force language at browser level
                ],
                stealth: useStealth,
                stealthOptions: {
                    addLanguage: false,
                    addPlugins: false,
                    emulateConsoleDebug: false,
                    emulateWebGL: false,
                    hideWebDriver: true,
                    emulateWindowFrame: false,
                    hackPermissions: false,
                    mockChrome: false,
                    mockDeviceMemory: false,
                    mockChromeInIframe: false,
                },
            });
        },
        useSessionPool: true,
        // This is just passed to gotoFunction
        pageLoadTimeoutSec,
        // long timeout, because of long infinite scroll
        handlePageTimeoutSecs: 30 * 60,
        maxRequestRetries: maxPageRetries,
    };

    // workaround for the maxCrawledPlaces when using multiple queries/startUrls
    // @ts-ignore
    scrapingOptions.multiplier = startRequests.length || 1;

    // Create and run crawler
    const crawler = placesCrawler.setUpCrawler(crawlerOptions, scrapingOptions, stats, allPlaces);

    await crawler.run();
    await stats.saveStats();

    if (cachePlaces) {
        log.debug('Saving places before migration');
        const allPlacesStore = await Apify.openKeyValueStore(cachedPlacesName);
        const reloadedPlaces = await allPlacesStore.getValue('places') || {};
        // @ts-ignore
        const newPlaces = { ...allPlaces, ...reloadedPlaces };
        await allPlacesStore.setValue('places', newPlaces);
    }

    if (regularTestRun) {
        const { defaultDatasetId: datasetId } = Apify.getEnv();
        await Apify.call('drobnikj/check-crawler-results', {
            datasetId,
            options: {
                minOutputtedPages: 5,
                jsonSchema: resultJsonSchema,
                notifyTo: 'lukas@apify.com',
            },
        });
    }

    log.info('Scraping finished!');
});
