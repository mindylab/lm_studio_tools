import { Readability } from '@mozilla/readability';
import { load } from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { convert as htmlToText } from 'html-to-text';
import { JSDOM } from 'jsdom';
import { YoutubeTranscript } from 'youtube-transcript';

const DEFAULT_FETCH_TIMEOUT_MS = parseInteger(
  process.env.LM_WEB_MCP_FETCH_TIMEOUT_MS,
  20_000,
);
const DEFAULT_MAX_CONTENT_CHARS = parseInteger(
  process.env.LM_WEB_MCP_DEFAULT_MAX_CONTENT_CHARS,
  12_000,
);
const MAX_YOUTUBE_TRANSCRIPT_CHARS = Math.max(
  1_000,
  parseInteger(process.env.LM_WEB_MCP_MAX_YOUTUBE_TRANSCRIPT_CHARS, 1_000_000),
);
const DEFAULT_MAX_TRANSCRIPT_CHARS = parseInteger(
  process.env.LM_WEB_MCP_DEFAULT_MAX_TRANSCRIPT_CHARS,
  0,
);
const MAX_DOWNLOAD_BYTES = parseInteger(
  process.env.LM_WEB_MCP_MAX_DOWNLOAD_BYTES,
  5_000_000,
);
const DEFAULT_COUNTRY_CODE = process.env.LM_WEB_MCP_SEARCH_COUNTRY_CODE ?? 'us';
const DEFAULT_LANGUAGE = process.env.LM_WEB_MCP_SEARCH_LANGUAGE ?? 'en-US';
const ENABLE_JINA_FALLBACK = process.env.LM_WEB_MCP_ENABLE_JINA_FALLBACK !== '0';
const USER_AGENT =
  process.env.LM_WEB_MCP_USER_AGENT ??
  'local-web-mcp/0.1 (+https://github.com/modelcontextprotocol)';

const RSS_PARSER = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
});

const CONTENT_SELECTORS = [
  'article',
  'main',
  '[role="main"]',
  '.article-content',
  '.article-body',
  '.post-content',
  '.entry-content',
  '.content',
  '#content',
  '#main-content',
];

export {
  DEFAULT_MAX_CONTENT_CHARS,
  DEFAULT_MAX_TRANSCRIPT_CHARS,
  ENABLE_JINA_FALLBACK,
  MAX_YOUTUBE_TRANSCRIPT_CHARS,
};

export async function searchWeb({
  query,
  count = 5,
  site,
  countryCode = DEFAULT_COUNTRY_CODE,
  language = DEFAULT_LANGUAGE,
}) {
  const normalizedCount = clamp(count, 1, 10);
  const trimmedQuery = query.trim();
  const fullQuery = site ? `${trimmedQuery} site:${site.trim()}` : trimmedQuery;
  let braveFailed = false;
  let results = [];

  try {
    results = await searchBraveHtml({
      fullQuery,
      count: normalizedCount,
      countryCode,
      language,
    });
  } catch {
    braveFailed = true;
  }

  const finalResults = !braveFailed
    ? results
    : await searchBingRss({
        fullQuery,
        count: normalizedCount,
        countryCode,
        language,
      });

  return {
    query: trimmedQuery,
    fullQuery,
    backend: braveFailed ? 'bing-rss' : 'brave-html',
    market: {
      countryCode,
      language,
    },
    results: finalResults,
    text: formatSearchText(fullQuery, finalResults),
  };
}

export async function fetchWebPage({
  url,
  maxChars = DEFAULT_MAX_CONTENT_CHARS,
  preferReader = true,
}) {
  const normalizedUrl = normalizeUrl(url);
  const limitedChars = clamp(maxChars, 1_000, 30_000);

  try {
    const directResult = await fetchWebPageDirect(normalizedUrl, limitedChars);

    if (
      preferReader &&
      ENABLE_JINA_FALLBACK &&
      shouldTryJinaFallback(directResult)
    ) {
      const fallback = await tryFetchViaJina(normalizedUrl, limitedChars);
      if (fallback && fallback.text.length > directResult.text.length) {
        return fallback;
      }
    }

    return directResult;
  } catch (error) {
    if (preferReader && ENABLE_JINA_FALLBACK) {
      const fallback = await tryFetchViaJina(normalizedUrl, limitedChars);
      if (fallback) {
        return fallback;
      }
    }

    throw error;
  }
}

export async function fetchYouTubeTranscript({
  url,
  videoId,
  language,
  includeTimestamps = true,
  maxChars = DEFAULT_MAX_TRANSCRIPT_CHARS,
}) {
  const id = normalizeYouTubeVideoId(videoId || extractYouTubeVideoId(url));
  const limitedChars = normalizeYouTubeTranscriptMaxChars(maxChars);
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(id)}&hl=en`;
  const { text: watchHtml } = await fetchText(watchUrl, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  });
  const playerResponse = extractYouTubePlayerResponse(watchHtml);
  const videoDetails = playerResponse.videoDetails ?? {};
  const captionTracks =
    playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
    throw new Error(
      `No transcript/caption tracks were found for YouTube video ${id}.`,
    );
  }

  const selectedTrack = selectYouTubeCaptionTrack(captionTracks, language);
  const transcript = await fetchYouTubeTranscriptSegments(id, selectedTrack);
  const lines = transcript.segments.map((segment) => {
    if (!includeTimestamps) {
      return segment.text;
    }

    return `[${formatTimestamp(segment.startMs)}] ${segment.text}`;
  });
  const rawBody = normalizeText(lines.join('\n'));
  const body = truncateText(rawBody, limitedChars);
  const title = cleanInlineText(videoDetails.title) || id;
  const channel = cleanInlineText(videoDetails.author) || null;
  const thumbnailUrl = selectYouTubeThumbnailUrl(videoDetails.thumbnail, id);
  const selectedLanguage =
    selectedTrack.languageCode ||
    cleanInlineText(selectedTrack.name?.simpleText) ||
    null;

  return {
    videoId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title,
    channel,
    thumbnailUrl,
    language: selectedLanguage,
    trackName: getYouTubeTrackName(selectedTrack),
    isAutoGenerated: selectedTrack.kind === 'asr',
    segmentCount: transcript.segments.length,
    truncated: rawBody.length > limitedChars,
    text: body,
    formattedText: [
      `Title: ${title}`,
      `URL: https://www.youtube.com/watch?v=${id}`,
      channel ? `Channel: ${channel}` : null,
      thumbnailUrl ? `Thumbnail image URL: ${thumbnailUrl}` : null,
      selectedLanguage ? `Transcript language: ${selectedLanguage}` : null,
      selectedTrack.kind === 'asr' ? 'Transcript type: auto-generated' : null,
      '',
      body,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export async function captureWebPageToImages({
  url,
  viewportWidth = 1280,
  viewportHeight = 900,
  fullPage = true,
  waitUntil = 'networkidle',
  waitAfterLoadMs = 1_000,
  scrollToLoad = true,
  segmentHeight = 10_000,
  maxPageHeight = 50_000,
  format = 'png',
  jpegQuality = 90,
}) {
  const normalizedUrl = normalizeUrl(url);
  const normalizedViewportWidth = clamp(viewportWidth, 320, 3840);
  const normalizedViewportHeight = clamp(viewportHeight, 320, 2160);
  const normalizedSegmentHeight = clamp(segmentHeight, 1_000, 16_000);
  const normalizedMaxPageHeight = clamp(maxPageHeight, 1_000, 100_000);
  const normalizedFormat = format === 'jpeg' ? 'jpeg' : 'png';
  const normalizedJpegQuality = clamp(jpegQuality, 1, 100);
  const browser = await launchChromium();
  let warning = null;

  try {
    const page = await browser.newPage({
      viewport: {
        width: normalizedViewportWidth,
        height: normalizedViewportHeight,
      },
      deviceScaleFactor: 1,
    });

    await page.goto(normalizedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: DEFAULT_FETCH_TIMEOUT_MS,
    });

    const loadWarning = await waitForLoadState(page, waitUntil);
    if (loadWarning) {
      warning = loadWarning;
    }

    if (waitAfterLoadMs > 0) {
      await page.waitForTimeout(clamp(waitAfterLoadMs, 0, 10_000));
    }

    if (scrollToLoad && fullPage) {
      await scrollThroughPage(page, normalizedViewportHeight, normalizedMaxPageHeight);
    }

    const dimensions = await getRenderedPageDimensions(page);
    const captureHeight = fullPage
      ? Math.min(dimensions.height, normalizedMaxPageHeight)
      : normalizedViewportHeight;
    const finalUrl = normalizeUrl(page.url());
    const title = normalizeText(await page.title()) || finalUrl;
    const images = [];

    if (fullPage && dimensions.height > normalizedMaxPageHeight) {
      warning = appendWarning(
        warning,
        `Page height is ${dimensions.height}px; captured the first ${normalizedMaxPageHeight}px.`,
      );
    }

    await page.setViewportSize({
      width: normalizedViewportWidth,
      height: normalizedViewportHeight,
    });
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(100);

    if (fullPage && captureHeight === dimensions.height && captureHeight <= normalizedSegmentHeight) {
      const buffer = await page.screenshot({
        type: normalizedFormat,
        quality: normalizedFormat === 'jpeg' ? normalizedJpegQuality : undefined,
        fullPage: true,
        scale: 'css',
      });

      images.push({
        index: images.length + 1,
        data: buffer.toString('base64'),
        mimeType: `image/${normalizedFormat}`,
        width: normalizedViewportWidth,
        height: captureHeight,
        pageX: 0,
        pageY: 0,
        pageWidth: dimensions.width,
        pageHeight: dimensions.height,
        sizeBytes: buffer.length,
      });
    } else {
      for (let y = 0; y < captureHeight; y += normalizedSegmentHeight) {
        const clipHeight = Math.min(normalizedSegmentHeight, captureHeight - y);
        const buffer = await page.screenshot({
          type: normalizedFormat,
          quality: normalizedFormat === 'jpeg' ? normalizedJpegQuality : undefined,
          clip: {
            x: 0,
            y,
            width: normalizedViewportWidth,
            height: clipHeight,
          },
          scale: 'css',
        });

        images.push({
          index: images.length + 1,
          data: buffer.toString('base64'),
          mimeType: `image/${normalizedFormat}`,
          width: normalizedViewportWidth,
          height: clipHeight,
          pageX: 0,
          pageY: y,
          pageWidth: dimensions.width,
          pageHeight: dimensions.height,
          sizeBytes: buffer.length,
        });
      }
    }

    const result = {
      url: normalizedUrl,
      finalUrl,
      title,
      viewportWidth: normalizedViewportWidth,
      viewportHeight: normalizedViewportHeight,
      fullPage,
      pageWidth: dimensions.width,
      pageHeight: dimensions.height,
      capturedHeight: captureHeight,
      format: normalizedFormat,
      images,
      warning,
    };

    return {
      ...result,
      text: formatPageToImagesText(result),
    };
  } finally {
    await browser.close();
  }
}

export async function searchAndFetch({
  query,
  count = 5,
  openTop = 3,
  maxCharsPerPage = Math.min(DEFAULT_MAX_CONTENT_CHARS, 6_000),
  site,
  countryCode = DEFAULT_COUNTRY_CODE,
  language = DEFAULT_LANGUAGE,
}) {
  const search = await searchWeb({
    query,
    count,
    site,
    countryCode,
    language,
  });

  const normalizedOpenTop = clamp(openTop, 1, 3);
  const targets = search.results.slice(0, normalizedOpenTop);

  const pages = await Promise.all(
    targets.map(async (result) => {
      try {
        return await fetchWebPage({
          url: result.url,
          maxChars: maxCharsPerPage,
          preferReader: true,
        });
      } catch (error) {
        return {
          url: result.url,
          finalUrl: result.url,
          title: result.title,
          description: result.snippet,
          publishedTime: result.publishedAt,
          contentType: null,
          sourceMethod: 'error',
          truncated: false,
          text: '',
          warning: errorMessage(error),
        };
      }
    }),
  );

  return {
    query: search.query,
    fullQuery: search.fullQuery,
    market: search.market,
    backend: search.backend,
    results: search.results,
    pages,
    text: formatSearchAndFetchText(search.results, pages, search.fullQuery),
  };
}

function extractYouTubeVideoId(value) {
  if (!value) {
    throw new Error('Provide either a YouTube URL or a videoId.');
  }

  const raw = String(value).trim();
  if (/^[\w-]{11}$/.test(raw)) {
    return raw;
  }

  const parsed = new URL(raw);
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase();

  if (host === 'youtu.be') {
    return parsed.pathname.split('/').filter(Boolean)[0];
  }

  if (host.endsWith('youtube.com')) {
    const watchId = parsed.searchParams.get('v');
    if (watchId) {
      return watchId;
    }

    const parts = parsed.pathname.split('/').filter(Boolean);
    if (['shorts', 'embed', 'live'].includes(parts[0]) && parts[1]) {
      return parts[1];
    }
  }

  throw new Error('Could not find a YouTube video id in the provided value.');
}

function normalizeYouTubeVideoId(value) {
  const id = String(value ?? '').trim();
  if (!/^[\w-]{11}$/.test(id)) {
    throw new Error(`Invalid YouTube video id "${id}".`);
  }

  return id;
}

function extractYouTubePlayerResponse(html) {
  const marker = 'ytInitialPlayerResponse';
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) {
    throw new Error('Could not find YouTube player metadata.');
  }

  const objectStart = html.indexOf('{', markerIndex);
  if (objectStart < 0) {
    throw new Error('Could not find YouTube player metadata object.');
  }

  const objectText = extractBalancedJsonObject(html, objectStart);
  try {
    return JSON.parse(objectText);
  } catch (error) {
    throw new Error(`Could not parse YouTube player metadata: ${errorMessage(error)}`);
  }
}

function selectYouTubeThumbnailUrl(thumbnail, videoId) {
  const candidates = Array.isArray(thumbnail?.thumbnails)
    ? thumbnail.thumbnails
    : [];
  const selected = candidates
    .filter((candidate) => typeof candidate?.url === 'string' && candidate.url.trim())
    .sort((a, b) => {
      const aSize = Number(a.width ?? 0) * Number(a.height ?? 0);
      const bSize = Number(b.width ?? 0) * Number(b.height ?? 0);
      return bSize - aSize;
    })[0];

  return normalizeYouTubeThumbnailUrl(selected?.url) ||
    `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
}

function normalizeYouTubeThumbnailUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return null;
  }
  if (raw.startsWith('//')) {
    return `https:${raw}`;
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return raw;
  }
  return null;
}

function extractBalancedJsonObject(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  throw new Error('Could not read the full YouTube player metadata object.');
}

function selectYouTubeCaptionTrack(captionTracks, language) {
  const requested = String(language ?? '').trim().toLowerCase();
  const normalizedTracks = captionTracks.filter((track) => track?.baseUrl);

  if (normalizedTracks.length === 0) {
    throw new Error('No usable YouTube transcript tracks were found.');
  }

  if (requested) {
    const exact =
      normalizedTracks.find((track) => String(track.languageCode ?? '').toLowerCase() === requested) ??
      normalizedTracks.find((track) =>
        String(track.vssId ?? '').toLowerCase().includes(`.${requested}`),
      );

    if (exact) {
      return exact;
    }
  }

  return (
    normalizedTracks.find((track) => track.kind !== 'asr' && String(track.languageCode ?? '').startsWith('en')) ??
    normalizedTracks.find((track) => String(track.languageCode ?? '').startsWith('en')) ??
    normalizedTracks.find((track) => track.kind !== 'asr') ??
    normalizedTracks[0]
  );
}

async function fetchYouTubeCaptionTrack(track) {
  const url = new URL(track.baseUrl);
  url.searchParams.set('fmt', 'json3');

  try {
    const { text } = await fetchText(url.toString(), {
      accept: 'application/json,text/plain,*/*;q=0.8',
    });
    const parsed = JSON.parse(text);
    const segments = parseYouTubeJson3Transcript(parsed);
    if (segments.length > 0) {
      return { segments };
    }
  } catch {
    // Fall through to XML subtitles below.
  }

  const xmlUrl = new URL(track.baseUrl);
  xmlUrl.searchParams.delete('fmt');
  const { text } = await fetchText(xmlUrl.toString(), {
    accept: 'application/xml,text/xml,text/plain,*/*;q=0.8',
  });

  return {
    segments: parseYouTubeXmlTranscript(text),
  };
}

async function fetchYouTubeTranscriptSegments(videoId, selectedTrack) {
  const language = selectedTrack?.languageCode || undefined;

  try {
    const segments = await YoutubeTranscript.fetchTranscript(videoId, {
      lang: language,
    });
    const normalizedSegments = normalizeYouTubePackageSegments(segments);
    if (normalizedSegments.length > 0) {
      return { segments: normalizedSegments };
    }
  } catch {
    // Fall back to the caption URL exposed in YouTube player metadata.
  }

  const fallback = await fetchYouTubeCaptionTrack(selectedTrack);
  if (fallback.segments.length === 0) {
    throw new Error(
      `Transcript track "${getYouTubeTrackName(selectedTrack)}" was found, but YouTube returned no transcript text.`,
    );
  }

  return fallback;
}

function normalizeYouTubePackageSegments(segments) {
  if (!Array.isArray(segments)) {
    return [];
  }

  return segments
    .map((segment) => {
      const text = normalizeText(segment?.text ?? '');
      if (!text) {
        return null;
      }

      return {
        startMs: Number(segment.offset ?? 0),
        durationMs: Number(segment.duration ?? 0),
        text,
      };
    })
    .filter(Boolean);
}

function parseYouTubeJson3Transcript(parsed) {
  const events = Array.isArray(parsed?.events) ? parsed.events : [];
  return events
    .map((event) => {
      const text = normalizeText(
        (event.segs ?? [])
          .map((segment) => segment?.utf8 ?? '')
          .join(''),
      );

      if (!text) {
        return null;
      }

      return {
        startMs: Number(event.tStartMs ?? 0),
        durationMs: Number(event.dDurationMs ?? 0),
        text,
      };
    })
    .filter(Boolean);
}

function parseYouTubeXmlTranscript(xml) {
  const parsed = RSS_PARSER.parse(xml);
  const nodes = toArray(parsed?.transcript?.text);
  return nodes
    .map((node) => {
      const text = cleanInlineText(node?.['#text'] ?? node);
      if (!text) {
        return null;
      }

      return {
        startMs: Math.floor(Number(node?.['@_start'] ?? 0) * 1000),
        durationMs: Math.floor(Number(node?.['@_dur'] ?? 0) * 1000),
        text,
      };
    })
    .filter(Boolean);
}

function getYouTubeTrackName(track) {
  return (
    cleanInlineText(track?.name?.simpleText) ||
    cleanInlineText(track?.name?.runs?.map((run) => run.text).join('')) ||
    String(track?.languageCode ?? '')
  );
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.floor(Number(milliseconds ?? 0) / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`;
  }

  return `${minutes}:${ss}`;
}

function shouldTryJinaFallback(result) {
  if (!result.text) {
    return true;
  }

  if (result.contentType && result.contentType.includes('application/pdf')) {
    return true;
  }

  return result.text.length < 1_500;
}

async function searchBraveHtml({ fullQuery, count, countryCode, language }) {
  const searchUrl =
    `https://search.brave.com/search?q=${encodeURIComponent(fullQuery)}` +
    `&source=web&country=${encodeURIComponent(countryCode.toLowerCase())}` +
    `&language=${encodeURIComponent(language.toLowerCase())}` +
    '&spellcheck=0';

  const { text } = await fetchText(searchUrl, {
    accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
  });
  const $ = load(text);
  const results = $('div.snippet[data-type="web"]')
    .slice(0, count)
    .toArray()
    .map((node, index) => {
      try {
        const root = $(node);
        const href = root.find('a[href^="http"]').first().attr('href');
        const title = cleanInlineText(
          root.find('div.title, a.title, h2, h3').first().text(),
        );
        const rawSnippet = cleanInlineText(
          root.find('div.generic-snippet .content, div.description').first().text(),
        );
        const { snippet, publishedAt } = splitPublishedPrefix(rawSnippet);

        if (!href || !title) {
          return null;
        }

        return {
          index: index + 1,
          title,
          url: normalizeUrl(href),
          snippet,
          publishedAt,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return results;
}

async function searchBingRss({ fullQuery, count, countryCode, language }) {
  const searchUrl =
    `https://www.bing.com/search?format=rss&q=${encodeURIComponent(fullQuery)}` +
    `&cc=${encodeURIComponent(countryCode)}` +
    `&setlang=${encodeURIComponent(language)}`;

  const { text } = await fetchText(searchUrl, {
    accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
  });
  const parsed = RSS_PARSER.parse(text);
  const items = toArray(parsed?.rss?.channel?.item);

  return items
    .slice(0, count)
    .map((item, index) => {
      try {
        return {
          index: index + 1,
          title: cleanInlineText(item.title),
          url: normalizeUrl(item.link),
          snippet: cleanInlineText(item.description),
          publishedAt: cleanInlineText(item.pubDate) || null,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function fetchWebPageDirect(url, maxChars) {
  const { response, text } = await fetchText(url, {
    accept: 'text/html,application/xhtml+xml,text/plain,application/pdf,*/*;q=0.8',
  });

  const finalUrl = normalizeUrl(response.url || url);
  const contentTypeHeader = response.headers.get('content-type');
  const contentType = normalizeContentType(contentTypeHeader);

  if (contentType.includes('text/html') || looksLikeHtml(text)) {
    const extracted = extractFromHtml(text, finalUrl, maxChars);

    return {
      ...extracted,
      url,
      finalUrl,
      contentType,
      sourceMethod: extracted.sourceMethod ?? 'direct-html',
    };
  }

  return {
    url,
    finalUrl,
    title: finalUrl,
    description: null,
    publishedTime: null,
    contentType,
    sourceMethod: 'direct-text',
    truncated: text.length > maxChars,
    text: truncateText(normalizeText(text), maxChars),
  };
}

async function tryFetchViaJina(url, maxChars) {
  try {
    return await fetchViaJina(url, maxChars);
  } catch {
    return null;
  }
}

async function fetchViaJina(url, maxChars) {
  const readerUrl = `https://r.jina.ai/http://${url}`;
  const { text } = await fetchText(readerUrl, {
    accept: 'text/plain, text/markdown;q=0.9, */*;q=0.8',
  });

  const contentStart = text.indexOf('Markdown Content:');
  const metadataBlock = contentStart >= 0 ? text.slice(0, contentStart) : '';
  const body = contentStart >= 0 ? text.slice(contentStart + 'Markdown Content:'.length) : text;
  const title = extractMetadataValue(metadataBlock, 'Title') || url;
  const finalUrl = extractMetadataValue(metadataBlock, 'URL Source') || url;
  const publishedTime = extractMetadataValue(metadataBlock, 'Published Time');
  const warning = extractMetadataValue(metadataBlock, 'Warning');
  const normalizedText = normalizeText(body);

  return {
    url,
    finalUrl: normalizeUrl(finalUrl),
    title,
    description: null,
    publishedTime,
    contentType: 'text/markdown',
    sourceMethod: 'jina-reader',
    truncated: normalizedText.length > maxChars,
    text: truncateText(normalizedText, maxChars),
    warning: warning || null,
  };
}

async function fetchText(url, { accept = '*/*' } = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    headers: {
      accept,
      'accept-language': DEFAULT_LANGUAGE,
      'user-agent': USER_AGENT,
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed with ${response.status} ${response.statusText}`.trim());
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `Refusing to download ${contentLength} bytes because it exceeds the ${MAX_DOWNLOAD_BYTES}-byte limit.`,
    );
  }

  const text = await response.text();
  if (text.length > MAX_DOWNLOAD_BYTES * 2) {
    throw new Error('Downloaded content is unexpectedly large.');
  }

  return {
    response,
    text,
  };
}

function extractFromHtml(html, url, maxChars) {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  const title =
    getMetaContent(document, 'meta[property="og:title"]') ||
    getMetaContent(document, 'meta[name="twitter:title"]') ||
    normalizeText(document.title) ||
    url;
  const description =
    getMetaContent(document, 'meta[name="description"]') ||
    getMetaContent(document, 'meta[property="og:description"]') ||
    getMetaContent(document, 'meta[name="twitter:description"]') ||
    null;
  const publishedTime =
    getMetaContent(document, 'meta[property="article:published_time"]') ||
    getMetaContent(document, 'meta[name="pubdate"]') ||
    getMetaContent(document, 'meta[name="date"]') ||
    null;

  let text = '';
  let sourceMethod = 'direct-html';

  try {
    const article = new Readability(document).parse();
    if (article?.textContent) {
      text = normalizeText(article.textContent);
      if (article.title) {
        sourceMethod = 'readability';
      }
    }
  } catch {
    text = '';
  }

  if (!text || text.length < 1_000) {
    text = extractWithCheerio(html);
    sourceMethod = 'cheerio-fallback';
  }

  return {
    title,
    description,
    publishedTime,
    truncated: text.length > maxChars,
    text: truncateText(text, maxChars),
    sourceMethod,
  };
}

function extractWithCheerio(html) {
  const $ = load(html);

  $(
    [
      'script',
      'style',
      'noscript',
      'svg',
      'canvas',
      'iframe',
      'form',
      'button',
      'input',
      'header',
      'footer',
      'nav',
      'aside',
      '[aria-hidden="true"]',
    ].join(','),
  ).remove();

  let bestHtml = '';
  let bestLength = 0;

  for (const selector of CONTENT_SELECTORS) {
    const nodes = $(selector).toArray();
    if (nodes.length === 0) {
      continue;
    }

    const candidateHtml = nodes.map((node) => $(node).html() || '').join('\n');
    const candidateText = normalizeText(
      htmlToText(candidateHtml, textConversionOptions()),
    );

    if (candidateText.length > bestLength) {
      bestHtml = candidateHtml;
      bestLength = candidateText.length;
    }
  }

  const baseHtml = bestHtml || $('body').html() || html;
  return normalizeText(htmlToText(baseHtml, textConversionOptions()));
}

function textConversionOptions() {
  return {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'svg', format: 'skip' },
    ],
  };
}

function formatSearchText(query, results) {
  if (results.length === 0) {
    return `No search results were found for "${query}".`;
  }

  return [
    `Search results for "${query}":`,
    ...results.map((result) =>
      [
        `${result.index}. ${result.title}`,
        `URL: ${result.url}`,
        result.publishedAt ? `Published: ${result.publishedAt}` : null,
        result.snippet ? `Snippet: ${result.snippet}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n\n');
}

function formatSearchAndFetchText(results, pages, query) {
  const header = formatSearchText(query, results);
  const pageSections = pages.map((page, index) =>
    [
      `Page ${index + 1}: ${page.title}`,
      `URL: ${page.finalUrl}`,
      page.publishedTime ? `Published: ${page.publishedTime}` : null,
      page.warning ? `Warning: ${page.warning}` : null,
      page.text ? page.text : 'No page text could be extracted.',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  return [header, ...pageSections].join('\n\n---\n\n');
}

async function launchChromium() {
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: [
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-dev-shm-usage',
        '--disable-setuid-sandbox',
        '--no-sandbox',
      ],
    });
  } catch (error) {
    const message = errorMessage(error);
    if (
      message.includes('Cannot find package') ||
      message.includes('Executable doesn') ||
      message.includes('browserType.launch')
    ) {
      throw new Error(
        `${message}\nInstall the screenshot browser with: npx playwright install chromium`,
      );
    }

    throw error;
  }
}

async function waitForLoadState(page, waitUntil) {
  try {
    await page.waitForLoadState(waitUntil, {
      timeout: Math.min(DEFAULT_FETCH_TIMEOUT_MS, 15_000),
    });
    return null;
  } catch {
    return `Timed out waiting for "${waitUntil}"; captured the page after domcontentloaded instead.`;
  }
}

async function scrollThroughPage(page, viewportHeight, maxPageHeight) {
  const step = Math.max(200, Math.floor(viewportHeight * 0.85));
  let previousScrollY = -1;

  for (let index = 0; index < 200; index += 1) {
    const state = await page.evaluate(() => ({
      scrollY: Math.ceil(window.scrollY),
      innerHeight: Math.ceil(window.innerHeight),
      scrollHeight: Math.ceil(
        Math.max(
          document.documentElement?.scrollHeight ?? 0,
          document.body?.scrollHeight ?? 0,
        ),
      ),
    }));

    if (
      state.scrollY === previousScrollY ||
      state.scrollY + state.innerHeight >= state.scrollHeight ||
      state.scrollY + state.innerHeight >= maxPageHeight
    ) {
      break;
    }

    previousScrollY = state.scrollY;
    await page.evaluate((scrollStep) => {
      window.scrollBy(0, scrollStep);
    }, step);
    await page.waitForTimeout(200);
  }

  await page.evaluate(() => {
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(300);
}

async function getRenderedPageDimensions(page) {
  return page.evaluate(() => ({
    width: Math.ceil(
      Math.max(
        document.documentElement?.scrollWidth ?? 0,
        document.body?.scrollWidth ?? 0,
        window.innerWidth,
      ),
    ),
    height: Math.ceil(
      Math.max(
        document.documentElement?.scrollHeight ?? 0,
        document.body?.scrollHeight ?? 0,
        window.innerHeight,
      ),
    ),
  }));
}

function formatPageToImagesText(result) {
  return [
    `Captured "${result.title}" as ${result.images.length} image${result.images.length === 1 ? '' : 's'}.`,
    `URL: ${result.finalUrl}`,
    `Viewport: ${result.viewportWidth}x${result.viewportHeight}`,
    `Rendered page size: ${result.pageWidth}x${result.pageHeight}`,
    `Captured height: ${result.capturedHeight}`,
    `Format: ${result.format}`,
    result.warning ? `Warning: ${result.warning}` : null,
    '',
    ...result.images.map((image) =>
      [
        `Image ${image.index}`,
        `Size: ${image.width}x${image.height}`,
        `Page region: x=${image.pageX}, y=${image.pageY}, width=${image.width}, height=${image.height}`,
        `Bytes: ${image.sizeBytes}`,
      ].join('\n'),
    ),
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function truncateText(text, maxChars) {
  if (!text || text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, maxChars).trimEnd()}\n\n[truncated]`;
}

function normalizeYouTubeTranscriptMaxChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return clamp(numeric, 1_000, MAX_YOUTUBE_TRANSCRIPT_CHARS);
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cleanInlineText(value) {
  return normalizeText(
    load(`<div>${String(value ?? '')}</div>`).text(),
  ).replace(/\n+/g, ' ');
}

function splitPublishedPrefix(text) {
  const normalized = cleanInlineText(text);
  const match = normalized.match(
    /^((?:[A-Z][a-z]+ \d{1,2}, \d{4})|(?:\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago))\s+-\s+(.+)$/,
  );

  if (!match) {
    return {
      snippet: normalized,
      publishedAt: null,
    };
  }

  return {
    publishedAt: match[1],
    snippet: match[2],
  };
}

function extractMetadataValue(block, label) {
  const match = block.match(new RegExp(`^${escapeRegExp(label)}:\\s*(.+)$`, 'm'));
  return match ? match[1].trim() : null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getMetaContent(document, selector) {
  return normalizeText(document.querySelector(selector)?.getAttribute('content') || '');
}

function toArray(value) {
  if (!value) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function appendWarning(current, next) {
  return current ? `${current} ${next}` : next;
}

function normalizeUrl(value) {
  const url = new URL(String(value ?? ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https URLs are supported.');
  }

  return url.toString();
}

function looksLikeHtml(text) {
  const sample = String(text ?? '').slice(0, 500).toLowerCase();
  return sample.includes('<html') || sample.includes('<body') || sample.includes('<article');
}

function normalizeContentType(headerValue) {
  return String(headerValue ?? '').split(';')[0].trim().toLowerCase();
}

function errorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function clamp(value, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function parseInteger(value, fallback) {
  const numeric = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(numeric) ? numeric : fallback;
}
