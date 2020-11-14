const Apify = require('apify');
const Puppeteer = require('puppeteer'); // eslint-disable-line no-unused-vars
const Globalize = require('globalize');

const { DEFAULT_TIMEOUT, PLACE_TITLE_SEL } = require('./consts');
const { waitForGoogleMapLoader,scrollTo, enlargeImageUrls } = require('./utils');
const infiniteScroll = require('./infinite_scroll');

const { log, sleep } = Apify.utils;

// TODO: Fix these type anotations
/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractPageData = async ({ page }) => {
    return page.evaluate((placeTitleSel) => {
        const address = $('[data-section-id="ad"] .section-info-line').text().trim();
        const addressAlt = $("button[data-tooltip*='address']").text().trim();
        const addressAlt2 = $("button[data-item-id*='address']").text().trim();
        const secondaryAddressLine = $('[data-section-id="ad"] .section-info-secondary-text').text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt = $("button[data-tooltip*='locatedin']").text().replace('Located in:', '').trim();
        const secondaryAddressLineAlt2 = $("button[data-item-id*='locatedin']").text().replace('Located in:', '').trim();
        const phone = $('[data-section-id="pn0"].section-info-speak-numeral').length
            ? $('[data-section-id="pn0"].section-info-speak-numeral').attr('data-href').replace('tel:', '')
            : $("button[data-tooltip*='phone']").text().trim();
        const phoneAlt = $('button[data-item-id*=phone]').text().trim();
        let temporarilyClosed = false;
        let permanentlyClosed = false;
        const altOpeningHoursText = $('[class*="section-info-hour-text"] [class*="section-info-text"]').text().trim();
        if (altOpeningHoursText === 'Temporarily closed') temporarilyClosed = true;
        else if (altOpeningHoursText === 'Permanently closed') permanentlyClosed = true;

        return {
            title: $(placeTitleSel).text().trim(),
            subTitle: $('section-hero-header-title-subtitle').first().text().trim() || null,
            totalScore: $('span.section-star-display').eq(0).text().trim(),
            categoryName: $('[jsaction="pane.rating.category"]').text().trim(),
            address: address || addressAlt || addressAlt2 || null,
            locatedIn: secondaryAddressLine || secondaryAddressLineAlt || secondaryAddressLineAlt2 || null,
            plusCode: $('[data-section-id="ol"] .widget-pane-link').text().trim()
                || $("button[data-tooltip*='plus code']").text().trim()
                || $("button[data-item-id*='oloc']").text().trim() || null,
            website: $('[data-section-id="ap"]').length
                ? $('[data-section-id="ap"]').eq('0').text().trim()
                : $("button[data-tooltip*='website']").text().trim()
                || $("button[data-item-id*='authority']").text().trim() || null,
            phone: phone || phoneAlt || null,
            temporarilyClosed,
            permanentlyClosed,
        };
    }, PLACE_TITLE_SEL);
}

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
 */
module.exports.extractPopularTimes = async ({ page }) => {
    const output = {};
    // Include live popular times value
    const popularTimesLiveRawValue = await page.evaluate(() => {
        return $('.section-popular-times-live-value').attr('aria-label');
    });
    const popularTimesLiveRawText = await page.evaluate(() => $('.section-popular-times-live-description').text().trim());
    output.popularTimesLiveText = popularTimesLiveRawText;
    const popularTimesLivePercentMatch = popularTimesLiveRawValue ? popularTimesLiveRawValue.match(/(\d+)\s?%/) : null;
    output.popularTimesLivePercent = popularTimesLivePercentMatch ? Number(popularTimesLivePercentMatch[1]) : null;

    const histogramSel = '.section-popular-times';
    if (await page.$(histogramSel)) {
        output.popularTimesHistogram = await page.evaluate(() => {
            const graphs = {};
            const days = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
            // Extract all days graphs
            $('.section-popular-times-graph').each(function (i) {
                const day = days[i];
                graphs[day] = [];
                let graphStartFromHour;
                // Finds where x axis starts
                $(this).find('.section-popular-times-label').each(function (labelIndex) {
                    if (graphStartFromHour) return;
                    const hourText = $(this).text().trim();
                    graphStartFromHour = hourText.includes('p')
                        ? 12 + (parseInt(hourText, 10) - labelIndex)
                        : parseInt(hourText, 10) - labelIndex;
                });
                // Finds values from y axis
                $(this).find('.section-popular-times-bar').each(function (barIndex) {
                    const occupancyMatch = $(this).attr('aria-label').match(/\d+(\s+)?%/);
                    if (occupancyMatch && occupancyMatch.length) {
                        const maybeHour = graphStartFromHour + barIndex;
                        graphs[day].push({
                            hour: maybeHour > 24 ? maybeHour - 24 : maybeHour,
                            occupancyPercent: parseInt(occupancyMatch[0], 10),
                        });
                    }
                });
            });
            return graphs;
        });
    }
    return output;
}

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
*/
module.exports.extractOpeningHours = async ({ page }) => {
    let result;
    const openingHoursSel = '.section-open-hours-container.section-open-hours-container-hoverable';
    const openingHoursSelAlt = '.section-open-hours-container.section-open-hours';
    const openingHoursSelAlt2 = '.section-open-hours-container';
    const openingHoursEl = (await page.$(openingHoursSel)) || (await page.$(openingHoursSelAlt)) || (await page.$(openingHoursSelAlt2));
    if (openingHoursEl) {
        const openingHoursText = await page.evaluate((openingHoursEl) => {
            return openingHoursEl.getAttribute('aria-label');
        }, openingHoursEl);
        const openingHours = openingHoursText.split(openingHoursText.includes(';') ? ';' : ',');
        if (openingHours.length) {
            result = openingHours.map((line) => {
                const regexpResult = line.trim().match(/(\S+)\s(.*)/);
                if (regexpResult) {
                    let [match, day, hours] = regexpResult;
                    hours = hours.split('.')[0];
                    return { day, hours };
                }
                log.debug(`[PLACE]: Not able to parse opening hours: ${line}`);
            });
        }
    }
    return result;
}

/**
 * @param {{
 *    page: Puppeteer.Page
 * }} options
   */
module.exports.extractPeopleAlsoSearch = async ({ page }) => {
    let result = [];
    const peopleSearchContainer = await page.$('.section-carousel-scroll-container');
    if (peopleSearchContainer) {
        const cardSel = 'button[class$="card"]';
        const cards = await peopleSearchContainer.$$(cardSel);
        for (let i = 0; i < cards.length; i++) {
            const searchResult = await page.evaluate((index, sel) => {
                const card = $(sel).eq(index);
                return {
                    title: card.find('div[class$="title"]').text().trim(),
                    totalScore: card.find('span[class$="rating"]').text().trim(),
                };
            }, i, cardSel);
            // For some reason, puppeteer click doesn't work here
            await Promise.all([
                page.evaluate((button, index) => {
                    $(button).eq(index).click();
                }, cardSel, i),
                page.waitForNavigation({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
            ]);
            searchResult.url = await page.url();
            result.push(searchResult);
            await Promise.all([
                page.goBack({ waitUntil: ['domcontentloaded', 'networkidle2'] }),
                waitForGoogleMapLoader(page),
            ]);
        }
    }
    return result;
}

/**
 * @param {{
    *    page: Puppeteer.Page
    * }} options
      */
module.exports.extractAdditionalInfo = async ({ page }) => {
    let result;
    log.debug('[PLACE]: Scraping additional info.');
    const button = await page.$('button.section-editorial');
    try {
        await button.click();
        await page.waitForSelector('.section-attribute-group', { timeout: 3000 });
        result = await page.evaluate(() => {
            const result = {};
            $('.section-attribute-group').each((i, section) => {
                const key = $(section).find('.section-attribute-group-title').text().trim();
                const values = [];
                $(section).find('.section-attribute-group-container .section-attribute-group-item').each((i, sub) => {
                    const res = {};
                    const title = $(sub).text().trim();
                    const val = $(sub).find('.section-attribute-group-item-icon.maps-sprite-place-attributes-done').length > 0;
                    res[title] = val;
                    values.push(res);
                });
                result[key] = values;
            });
            return result;
        });
        const backButton = await page.$('button[aria-label*=Back]');
        await backButton.click();
    } catch (e) {
        log.info(`[PLACE]: ${e}Additional info not parsed`);
    }
    return result;
}


/**
 * totalScore is string because it is parsed via localization
 * @param {{
 * page: Puppeteer.Page,
 * maxImages: number,
 }} options
 */
module.exports.extractImages = async ({ page, maxImages }) => {
    if (!maxImages || maxImages === 0) {
        return undefined;
    }

    let resultImageUrls;

    const mainImageSel = '.section-hero-header-image-hero-container';
    const mainImage = await page.waitForSelector(mainImageSel);

    if (maxImages === 1) {
        const imageUrl = await mainImage.$eval('img', (el) => el.src);
        resultImageUrls = [imageUrl];
    }
    if (maxImages > 1) {
        await sleep(2000);
        await mainImage.click();
        let lastImage = null;
        let pageBottom = 10000;
        let imageUrls = [];

        while (true) {
            log.info(`[PLACE]: Infinite scroll for images started, url: ${page.url()}`);
            await infiniteScroll(page, pageBottom, '.section-scrollbox.scrollable-y', 'images', 1);
            imageUrls = await page.evaluate(() => {
                const urls = [];
                $('.gallery-image-high-res').each(function () {
                    const urlMatch = $(this).attr('style').match(/url\("(.*)"\)/);
                    if (!urlMatch) return;
                    let imageUrl = urlMatch[1];
                    if (imageUrl[0] === '/') imageUrl = `https:${imageUrl}`;
                    urls.push(imageUrl);
                });
                return urls;
            });
            if (imageUrls.length >= maxImages || lastImage === imageUrls[imageUrls.length - 1]) {
                log.info(`[PLACE]: Infinite scroll for images finished, url: ${page.url()}`);
                break;
            }
            log.info(`[PLACE]: Infinite scroll continuing for images, currently ${imageUrls.length}, url: ${page.url()}`);
            lastImage = imageUrls[imageUrls.length - 1];
            pageBottom += 6000;
        }
        resultImageUrls = imageUrls.slice(0, maxImages);
    }

    return enlargeImageUrls(resultImageUrls);
}
