import { BuyerRecord, SourcePlatform } from '../src/types.ts';
import { generateContentWithFallback, safeParseGeminiJSON } from './geminiService.ts';
import { verifyEmailDeliverability } from './emailValidator.ts';
import { crawlWebsiteForDirectEmails } from './websiteEmailCrawler.ts';

export interface SearchOptions {
  keyword: string;
  sources: SourcePlatform[];
  country?: string;
  maxResults?: number;
}

export interface SearchResult {
  leads: BuyerRecord[];
  status: 'success' | 'empty' | 'no_api_key' | 'service_unavailable' | 'error';
  message: string;
}

export async function searchBuyers(options: SearchOptions): Promise<SearchResult> {
  const { 
    keyword = 'Singing Bowls', 
    sources = ['Google', 'Facebook', 'LinkedIn', 'Directory', 'Website'], 
    country, 
    maxResults = 8 
  } = options;

  // Verify Gemini API key configuration
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.trim() === '') {
    return {
      leads: [],
      status: 'no_api_key',
      message: 'Gemini API key is not configured in the environment. Live buyer discovery requires a valid GEMINI_API_KEY to search and retrieve actual leads.'
    };
  }

  try {
    const targetCountry = country && country !== 'All' ? country : 'International (US, UK, EU, Japan, Australia, Canada)';
    const prompt = `You are an expert B2B buyer discovery and lead intelligence engine for an authentic Himalayan singing bowls and sound therapy export house.
Target Keyword / Niche: "${keyword}"
Platforms to query: ${sources.join(', ')}
Target Country filter: ${targetCountry}

CRITICAL DELIVERABILITY REQUIREMENTS:
1. We need ONLY authentic, operational businesses with legitimate, active domains and verifiable, deliverable email addresses.
2. DO NOT hallucinate, guess, or invent email addresses. The email domain MUST match the company's official website domain.
3. DO NOT output non-existent domains (e.g. domains that return NXDOMAIN like yoga-alliance.ca).
4. DO NOT provide generic auto-reject role accounts (e.g., support@, help@, jobs@, billing@) or large enterprise firewalled aliases (like gaiam.com, yogaworks.com) which routinely reject cold emails with 550 Access Denied or policy blocks.
5. DO NOT invent placeholder emails (such as info@... or hello@...) for parked domains or domains that do not have an active email service (like GoDaddy parked domains).
6. Focus on real sound meditation studios, holistic wellness centers, acoustic therapy academies, crystal and Tibetan singing bowl importers, yoga retail boutiques, and spiritual gift shops that have publicly published, active contact emails.

Identify up to ${Math.min(maxResults + 4, 20)} candidates to allow for deliverability filtering.

Return ONLY a valid JSON array of objects conforming strictly to this schema:
[
  {
    "email": "buyer@domain.com",
    "buyer_name": "Contact or Owner Name",
    "company_name": "Studio or Company Name",
    "website": "https://...",
    "country": "Country",
    "source_platform": "Google" | "Facebook" | "LinkedIn" | "Directory" | "Website"
  }
]

If no authentic matching prospects can be verified for this niche/country, return an empty JSON array: [].
Output ONLY valid JSON, no markdown outside JSON, no commentary.`;

    const responseText = await generateContentWithFallback(prompt, {
      responseMimeType: 'application/json'
    });

    if (!responseText) {
      return {
        leads: [],
        status: 'service_unavailable',
        message: 'The Gemini search service was unavailable or encountered high demand. Please try searching again in a moment.'
      };
    }

    const parsed = safeParseGeminiJSON<any[]>(responseText);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return {
        leads: [],
        status: 'empty',
        message: `No buyer prospects were found matching your keyword "${keyword}"${country && country !== 'All' ? ` in ${country}` : ''}. Try adjusting your search query or selecting additional platforms.`
      };
    }

    // Filter valid entries with email syntax
    const validEntries = parsed.filter(item => item && typeof item === 'object' && item.email && String(item.email).includes('@'));
    if (validEntries.length === 0) {
      return {
        leads: [],
        status: 'empty',
        message: `Search for "${keyword}" returned no leads with valid contact emails. Try broadening your search query.`
      };
    }

    // Run real-time DNS MX & deliverability verification on candidate leads
    const verifiedCandidates: BuyerRecord[] = [];
    const rejectedCandidates: BuyerRecord[] = [];

    // Check each candidate with website crawling (contact, about, header, footer) and DNS verification
    for (const item of validEntries) {
      const originalEmail = String(item.email || '').trim().toLowerCase();
      let email = originalEmail;
      const website = String(item.website || '').trim();
      let directEmailCrawled = false;
      let crawlSection: string | undefined;

      // Automatically crawl website contact, about pages, headers, and footers for direct emails
      if (website) {
        try {
          console.log(`[Discovery] Automatically crawling website contact/about/headers/footers for ${item.company_name || website}...`);
          const crawlResult = await crawlWebsiteForDirectEmails(website, originalEmail);
          if (crawlResult.found && crawlResult.directEmail) {
            console.log(`[Discovery] Direct email found via website crawl: ${crawlResult.directEmail} (original was ${originalEmail})`);
            email = crawlResult.directEmail;
            directEmailCrawled = true;
            crawlSection = crawlResult.sourceSection;
          } else {
            console.log(`[Discovery] No direct emails found on ${website} contact/about pages. Keeping original email: ${originalEmail}`);
          }
        } catch (crawlErr: any) {
          console.warn(`[Discovery] Website crawl failed for ${website}: ${crawlErr.message}. Keeping original email.`);
        }
      }

      const check = await verifyEmailDeliverability(email, website);

      const record: BuyerRecord = {
        email,
        buyer_name: String(item.buyer_name || 'Buyer Contact').trim(),
        company_name: String(item.company_name || 'Wellness Organization').trim(),
        website,
        country: String(item.country || (country && country !== 'All' ? country : 'International')).trim(),
        source_platform: (sources.includes(item.source_platform) ? item.source_platform : sources[0]) as SourcePlatform,
        category: 'unclassified',
        discovered_date: new Date().toISOString(),
        status: check.isDeliverable && check.status === 'verified' ? 'valid' : (check.status === 'risky' ? 'flagged' : 'invalid'),
        mx_record: check.mxRecord,
        mail_provider: check.mailProvider,
        deliverability_status: check.status,
        deliverability_reason: check.reason,
        crawled_direct_email: directEmailCrawled,
        original_discovered_email: directEmailCrawled ? originalEmail : undefined,
        crawl_source_section: crawlSection,
        notes: directEmailCrawled
          ? `Direct email crawled from website ${crawlSection || 'contact/about'} (${email}). Updated from ${originalEmail}. ${check.reason}`
          : check.reason
      };

      if (check.isDeliverable && check.status === 'verified') {
        verifiedCandidates.push(record);
      } else {
        rejectedCandidates.push(record);
      }

      if (verifiedCandidates.length >= maxResults) break;
    }

    // Return ONLY strictly verified leads to guarantee deliverability and prevent any bounce
    const finalLeads = verifiedCandidates.slice(0, maxResults);

    if (finalLeads.length === 0) {
      return {
        leads: [],
        status: 'empty',
        message: `Candidates were located, but none passed strict authentic deliverability verification (active DNS MX, matching operational website, and clear mailbox reputation). Unverifiable addresses were filtered out to protect your sender reputation.`
      };
    }

    const verifiedCount = finalLeads.filter(l => l.deliverability_status === 'verified').length;

    return {
      leads: finalLeads,
      status: 'success',
      message: `Discovered ${finalLeads.length} prospect(s) (${verifiedCount} verified with active DNS MX servers).`
    };
  } catch (err: any) {
    console.error('Gemini discovery search error:', err);
    return {
      leads: [],
      status: 'error',
      message: `Search error: ${err.message || 'Failed to query search provider.'}`
    };
  }
}

// Direct URL Scraper for Website Source Adapter
export async function scrapeUrlForEmails(targetUrl: string): Promise<{ emails: string[]; extractedRecords: Partial<BuyerRecord>[] }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36 ExportAutomation/3.0'
      }
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP Error: ${res.status}`);
    }

    const html = await res.text();
    const emailRegex = /([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z0-9_-]+)/gi;
    const matches = html.match(emailRegex) || [];

    const uniqueEmails = Array.from(new Set(matches.map(e => e.toLowerCase())))
      .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.gif') && !e.endsWith('.svg') && !e.includes('sentry') && !e.includes('wixpress'));

    // Infer title / company name from html title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const companyTitle = titleMatch ? titleMatch[1].trim().slice(0, 50) : new URL(targetUrl).hostname;

    // Run deliverability check on scraped emails
    const records: Partial<BuyerRecord>[] = [];
    const validEmails: string[] = [];

    for (const email of uniqueEmails) {
      const check = await verifyEmailDeliverability(email, targetUrl);
      records.push({
        email,
        buyer_name: 'Lead Contact',
        company_name: companyTitle,
        website: targetUrl,
        country: 'International',
        source_platform: 'Website',
        status: check.isDeliverable ? 'valid' : 'invalid',
        deliverability_status: check.status,
        deliverability_reason: check.reason,
        mx_record: check.mxRecord,
        mail_provider: check.mailProvider,
        notes: check.reason
      });
      if (check.isDeliverable) {
        validEmails.push(email);
      }
    }

    return { emails: validEmails.length > 0 ? validEmails : uniqueEmails, extractedRecords: records };
  } catch (err) {
    return { emails: [], extractedRecords: [] };
  }
}

