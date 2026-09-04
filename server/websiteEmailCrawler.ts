import { extractCleanDomain, areDomainsRelated } from './emailValidator.ts';

const DISALLOWED_LOCAL_PARTS = new Set([
  'abuse', 'legal', 'privacy', 'compliance', 'security', 'jobs', 'careers', 'hr',
  'billing', 'invoice', 'noreply', 'no-reply', 'donotreply', 'mailer-daemon',
  'daemon', 'postmaster', 'webmaster', 'hostmaster', 'bounce', 'root'
]);

const DISALLOWED_DOMAINS = new Set([
  'example.com', 'test.com', 'sample.com', 'placeholder.com', 'domain.com',
  'sentry.io', 'wixpress.com', 'wordpress.org', 'wordpress.com', 'cloudflare.com',
  'schema.org', 'googleapis.com', 'google.com', 'w3.org', 'github.com',
  'gravatar.com', 'shopify.com', 'myshopify.com', 'squarespace.com'
]);

export interface CrawledEmailResult {
  found: boolean;
  directEmail?: string;
  sourceUrl?: string;
  sourceSection?: 'contact_page' | 'about_page' | 'header' | 'footer' | 'homepage_mailto' | 'homepage';
  allDiscoveredEmails: string[];
}

interface EmailCandidate {
  email: string;
  score: number;
  sourceSection: 'contact_page' | 'about_page' | 'header' | 'footer' | 'homepage_mailto' | 'homepage';
  sourceUrl: string;
}

function cleanExtractedEmail(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let clean = raw.trim().toLowerCase();

  // Strip leading/trailing punctuation or quotes
  clean = clean.replace(/^[<"'\(\[\{]+|[>"'\)\]\}.,;:?!]+$/g, '');

  // Strip mailto:
  if (clean.startsWith('mailto:')) {
    clean = clean.replace(/^mailto:/, '').split('?')[0];
  }

  // Basic syntax check
  if (!clean.includes('@') || clean.length < 5 || clean.length > 100) return null;

  // Filter image extensions
  if (/\.(png|jpg|jpeg|gif|svg|webp|bmp|ico|css|js|woff|woff2|ttf)$/i.test(clean)) return null;

  const parts = clean.split('@');
  if (parts.length !== 2) return null;
  const [localPart, domainPart] = parts;

  if (!localPart || !domainPart || !domainPart.includes('.')) return null;

  if (DISALLOWED_LOCAL_PARTS.has(localPart)) return null;
  if (DISALLOWED_DOMAINS.has(domainPart)) return null;

  return clean;
}

async function fetchPageWithTimeout(url: string, timeoutMs: number = 3800): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ok: false, status: res.status, text: '' };
    }
    const text = await res.text();
    return { ok: true, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  }
}

function extractEmailsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const valid: string[] = [];
  for (const m of matches) {
    const cleaned = cleanExtractedEmail(m);
    if (cleaned) valid.push(cleaned);
  }
  return Array.from(new Set(valid));
}

function extractMailtoLinks(html: string): string[] {
  if (!html) return [];
  const mailtoRegex = /href=["']mailto:([^"'\s>]+)["']/gi;
  const emails: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mailtoRegex.exec(html)) !== null) {
    const raw = match[1];
    const cleaned = cleanExtractedEmail(raw);
    if (cleaned) emails.push(cleaned);
  }
  return Array.from(new Set(emails));
}

/**
 * Crawls a website's homepage, header, footer, contact, and about pages to find direct contact emails.
 */
export async function crawlWebsiteForDirectEmails(websiteUrl: string, originalEmail?: string): Promise<CrawledEmailResult> {
  if (!websiteUrl || typeof websiteUrl !== 'string') {
    return { found: false, allDiscoveredEmails: [] };
  }

  let normalizedUrl = websiteUrl.trim();
  if (!normalizedUrl.startsWith('http://') && !normalizedUrl.startsWith('https://')) {
    normalizedUrl = 'https://' + normalizedUrl;
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(normalizedUrl);
  } catch {
    return { found: false, allDiscoveredEmails: [] };
  }

  const origin = baseUrl.origin;
  const websiteDomain = extractCleanDomain(origin);
  const candidates: EmailCandidate[] = [];
  const visitedUrls = new Set<string>();

  // 1. Fetch Homepage
  visitedUrls.add(origin);
  visitedUrls.add(origin + '/');
  const home = await fetchPageWithTimeout(origin, 4000);

  if (!home.ok || !home.text) {
    return { found: false, allDiscoveredEmails: [] };
  }

  const homeHtml = home.text;

  // Check homepage mailto links (very high priority)
  const homeMailtos = extractMailtoLinks(homeHtml);
  for (const email of homeMailtos) {
    candidates.push({
      email,
      score: 80,
      sourceSection: 'homepage_mailto',
      sourceUrl: origin
    });
  }

  // Extract <header> and <footer> sections
  const headerMatch = homeHtml.match(/<header[\s\S]*?<\/header>/i);
  if (headerMatch) {
    const headerEmails = [
      ...extractMailtoLinks(headerMatch[0]),
      ...extractEmailsFromText(headerMatch[0])
    ];
    for (const email of headerEmails) {
      candidates.push({
        email,
        score: 75,
        sourceSection: 'header',
        sourceUrl: origin
      });
    }
  }

  const footerMatch = homeHtml.match(/<footer[\s\S]*?<\/footer>/i);
  if (footerMatch) {
    const footerEmails = [
      ...extractMailtoLinks(footerMatch[0]),
      ...extractEmailsFromText(footerMatch[0])
    ];
    for (const email of footerEmails) {
      candidates.push({
        email,
        score: 75,
        sourceSection: 'footer',
        sourceUrl: origin
      });
    }
  }

  // Extract general emails from homepage body
  const generalHomeEmails = extractEmailsFromText(homeHtml);
  for (const email of generalHomeEmails) {
    if (!candidates.some(c => c.email === email)) {
      candidates.push({
        email,
        score: 50,
        sourceSection: 'homepage',
        sourceUrl: origin
      });
    }
  }

  // 2. Discover Contact & About Links from Homepage HTML
  const linkRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"'>#]+)["'][^>]*>(.*?)<\/a>/gi;
  const subpageTargets: { url: string; type: 'contact' | 'about' }[] = [];
  let linkMatch: RegExpExecArray | null;

  while ((linkMatch = linkRegex.exec(homeHtml)) !== null) {
    const rawHref = linkMatch[1].trim();
    const anchorText = linkMatch[2].toLowerCase().replace(/<[^>]+>/g, '').trim();

    try {
      const resolved = new URL(rawHref, origin);
      // Ensure same origin
      if (resolved.origin.toLowerCase() === origin.toLowerCase()) {
        const path = resolved.pathname.toLowerCase();
        const fullHref = resolved.href;

        if (visitedUrls.has(fullHref)) continue;

        const isContact = path.includes('contact') || anchorText.includes('contact') || anchorText.includes('get in touch') || anchorText.includes('reach us');
        const isAbout = path.includes('about') || anchorText.includes('about') || path.includes('team') || path.includes('story') || anchorText.includes('our story');

        if (isContact) {
          subpageTargets.push({ url: fullHref, type: 'contact' });
          visitedUrls.add(fullHref);
        } else if (isAbout) {
          subpageTargets.push({ url: fullHref, type: 'about' });
          visitedUrls.add(fullHref);
        }
      }
    } catch {
      // ignore invalid relative url
    }
  }

  // If no contact or about pages were discovered, try standard candidate endpoints
  const fallbackContact = `${origin}/contact`;
  const fallbackContactUs = `${origin}/contact-us`;
  const fallbackAbout = `${origin}/about`;
  const fallbackAboutUs = `${origin}/about-us`;

  if (!subpageTargets.some(t => t.type === 'contact')) {
    if (!visitedUrls.has(fallbackContact)) subpageTargets.push({ url: fallbackContact, type: 'contact' });
    if (!visitedUrls.has(fallbackContactUs)) subpageTargets.push({ url: fallbackContactUs, type: 'contact' });
  }
  if (!subpageTargets.some(t => t.type === 'about')) {
    if (!visitedUrls.has(fallbackAbout)) subpageTargets.push({ url: fallbackAbout, type: 'about' });
    if (!visitedUrls.has(fallbackAboutUs)) subpageTargets.push({ url: fallbackAboutUs, type: 'about' });
  }

  // Limit crawling to max 4 target pages to maintain quick response
  const pagesToCrawl = subpageTargets.slice(0, 4);

  if (pagesToCrawl.length > 0) {
    const crawlPromises = pagesToCrawl.map(async target => {
      const page = await fetchPageWithTimeout(target.url, 3500);
      if (page.ok && page.text) {
        const mailtos = extractMailtoLinks(page.text);
        const textEmails = extractEmailsFromText(page.text);
        const allPageEmails = Array.from(new Set([...mailtos, ...textEmails]));

        for (const email of allPageEmails) {
          const isMailto = mailtos.includes(email);
          const baseScore = target.type === 'contact' ? 90 : 80;
          candidates.push({
            email,
            score: baseScore + (isMailto ? 10 : 0),
            sourceSection: target.type === 'contact' ? 'contact_page' : 'about_page',
            sourceUrl: target.url
          });
        }
      }
    });

    await Promise.allSettled(crawlPromises);
  }

  if (candidates.length === 0) {
    return { found: false, allDiscoveredEmails: [] };
  }

  // 3. Score and Rank Direct Emails
  // Add bonuses for domain matching & direct personal/inquiry aliases
  const scoredCandidates = candidates.map(c => {
    let finalScore = c.score;
    const emailDomain = c.email.split('@')[1] || '';
    const localPart = c.email.split('@')[0] || '';

    // Strong bonus if the email domain exactly matches the company's website domain
    if (websiteDomain && areDomainsRelated(emailDomain, websiteDomain)) {
      finalScore += 25;
    }

    // Bonus for dedicated business/contact roles or direct personal names
    if (['contact', 'info', 'hello', 'inquiries', 'wholesale', 'sales', 'studio', 'orders', 'namaste', 'connect'].includes(localPart)) {
      finalScore += 15;
    } else if (localPart.length >= 3 && !localPart.includes('support') && !localPart.includes('help')) {
      // Likely direct personal name (e.g., elena@, david@)
      finalScore += 20;
    }

    // Penalize generic support desks
    if (localPart === 'support' || localPart === 'help') {
      finalScore -= 30;
    }

    return { ...c, score: finalScore };
  });

  // Sort descending by score
  scoredCandidates.sort((a, b) => b.score - a.score);

  const best = scoredCandidates[0];
  const uniqueDiscovered = Array.from(new Set(scoredCandidates.map(c => c.email)));

  console.log(`[Crawler] Crawled ${websiteUrl} -> Found ${uniqueDiscovered.length} direct email(s). Best: ${best.email} (Score ${best.score} from ${best.sourceSection})`);

  return {
    found: true,
    directEmail: best.email,
    sourceUrl: best.sourceUrl,
    sourceSection: best.sourceSection,
    allDiscoveredEmails: uniqueDiscovered
  };
}
