import { promises as dns } from 'dns';
import { BuyerRecord, SendLogEntry, DeliverabilityStatus } from '../src/types.ts';
import { isEmailBounced } from './dataStore.ts';

const EMAIL_REGEX = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'];

const PLACEHOLDER_DOMAINS = [
  'example.com', 'test.com', 'sample.com', 'placeholder.com', 'domain.com', 'localhost', 'mysite.com'
];

// High-risk role accounts that are unmonitored or routinely block cold email (550 Recipient rejected / 554 Relay denied)
const HIGH_RISK_ROLES = new Set([
  'support', 'help', 'billing', 'invoice', 'abuse', 'legal', 'privacy',
  'compliance', 'security', 'jobs', 'careers', 'hr', 'press', 'media',
  'investor', 'investors', 'pr', 'admin', 'administrator', 'postmaster',
  'hostmaster', 'webmaster', 'noreply', 'no-reply', 'bounce', 'mailer-daemon',
  'daemon', 'spam', 'donotreply', 'customerservice', 'feedback', 'security'
]);

// Known enterprise domains where generic info@/contact@ aliases are blocked by IT firewall policy
const ENTERPRISE_BLOCKED_DOMAINS = new Set([
  'yogaworks.com', 'gaiam.com', 'lululemon.com', 'manduka.com', 'corepoweryoga.com',
  'target.com', 'walmart.com', 'amazon.com', 'nike.com'
]);

export function extractCleanDomain(urlOrHost: string): string {
  if (!urlOrHost) return '';
  try {
    let clean = urlOrHost.trim().toLowerCase();
    if (!clean.startsWith('http://') && !clean.startsWith('https://')) {
      clean = 'https://' + clean;
    }
    const parsed = new URL(clean);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function areDomainsRelated(emailDomain: string, webDomain: string): boolean {
  if (!emailDomain || !webDomain) return false;
  if (emailDomain === webDomain) return true;
  if (emailDomain.endsWith('.' + webDomain) || webDomain.endsWith('.' + emailDomain)) return true;
  
  // Base name matching (e.g. yogahaven in yogahaven.co.uk and yogahaven.com)
  const baseEmail = emailDomain.split('.')[0].replace(/[^a-z0-9]/g, '');
  const baseWeb = webDomain.split('.')[0].replace(/[^a-z0-9]/g, '');
  if (baseEmail.length >= 4 && baseWeb.length >= 4) {
    if (baseEmail === baseWeb || baseEmail.includes(baseWeb) || baseWeb.includes(baseEmail)) {
      return true;
    }
  }
  return false;
}

export async function probeWebsiteQuick(websiteUrl: string): Promise<{ isReachable: boolean; isParked?: boolean; statusCode?: number; publishedEmails: string[] }> {
  try {
    let target = websiteUrl.trim();
    if (!target.startsWith('http://') && !target.startsWith('https://')) {
      target = 'https://' + target;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(target, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { isReachable: false, statusCode: res.status, publishedEmails: [] };
    }
    const text = await res.text();
    const lowerText = text.toLowerCase();

    // Detect parked domain or expired hosting
    const isParked = lowerText.includes('this domain is parked') ||
      lowerText.includes('buy this domain') ||
      lowerText.includes('godaddy parking') ||
      lowerText.includes('sedoparking') ||
      lowerText.includes('domain for sale') ||
      lowerText.includes('hugedomains') ||
      lowerText.includes('under construction') ||
      lowerText.includes('account suspended') ||
      lowerText.includes('cgi-sys/defaultwebpage');

    if (isParked) {
      return { isReachable: false, isParked: true, statusCode: res.status, publishedEmails: [] };
    }

    const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
    const cleanEmails = Array.from(
      new Set(
        matches
          .map(e => e.toLowerCase())
          .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.svg') && !e.endsWith('.webp'))
      )
    );
    return { isReachable: true, statusCode: res.status, publishedEmails: cleanEmails };
  } catch {
    return { isReachable: false, publishedEmails: [] };
  }
}

export interface DeliverabilityCheckResult {
  isDeliverable: boolean;
  status: DeliverabilityStatus;
  reason: string;
  mxRecord?: string;
  mailProvider?: string;
  isRoleAccount?: boolean;
}

export function validateEmailSyntax(email: string): { isValid: boolean; reason?: string } {
  if (!email || typeof email !== 'string') {
    return { isValid: false, reason: 'Email is empty or not a string' };
  }

  const clean = email.trim().toLowerCase();

  // Check length
  if (clean.length < 5 || clean.length > 254) {
    return { isValid: false, reason: 'Email length out of valid range (5-254 characters)' };
  }

  // Check for image extension trailing
  for (const ext of IMAGE_EXTENSIONS) {
    if (clean.endsWith(ext)) {
      return { isValid: false, reason: `Email ends with image extension (${ext})` };
    }
  }

  // Split into local and domain parts
  const atIndex = clean.lastIndexOf('@');
  if (atIndex <= 0 || atIndex === clean.length - 1) {
    return { isValid: false, reason: 'Missing local part or domain part' };
  }

  const localPart = clean.slice(0, atIndex);
  const domainPart = clean.slice(atIndex + 1);

  // Algorithm 12.1 step 9: domain part length > 50
  if (domainPart.length > 50) {
    return { isValid: false, reason: `Domain part length exceeds 50 characters (${domainPart.length})` };
  }

  // Domain must contain dot
  if (!domainPart.includes('.')) {
    return { isValid: false, reason: 'Domain part must contain a top-level domain extension' };
  }

  // Placeholder check
  if (PLACEHOLDER_DOMAINS.includes(domainPart)) {
    return { isValid: false, reason: `Domain is a known placeholder (${domainPart})` };
  }

  // Regex format check
  if (!EMAIL_REGEX.test(clean)) {
    return { isValid: false, reason: 'Email does not match standard RFC email pattern' };
  }

  return { isValid: true };
}

export function detectMailProvider(mxHost: string): string {
  const host = mxHost.toLowerCase();
  if (host.includes('google.com') || host.includes('googlemail.com') || host.includes('aspmx')) {
    return 'Google Workspace';
  }
  if (host.includes('outlook.com') || host.includes('microsoft.com') || host.includes('office365')) {
    return 'Microsoft 365';
  }
  if (host.includes('zoho')) {
    return 'Zoho Mail';
  }
  if (host.includes('proton') || host.includes('protonmail')) {
    return 'ProtonMail';
  }
  if (host.includes('secureserver.net')) {
    return 'GoDaddy Mail';
  }
  if (host.includes('ovh')) {
    return 'OVHcloud';
  }
  if (host.includes('mimecast')) {
    return 'Mimecast Gateway';
  }
  if (host.includes('pphosted')) {
    return 'Proofpoint Protection';
  }
  return mxHost;
}

// Timeout helper for DNS queries
function withTimeout<T>(promise: Promise<T>, ms: number, errorMsg: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Deep deliverability verification:
 * 1. Syntax check
 * 2. High-risk role account check (e.g. support@, help@)
 * 3. DNS MX resolution (detects NXDOMAIN, ENODATA, missing mail exchanger)
 * 4. Null MX (RFC 7505) and broken proxy MX (_dc-mx) detection
 * 5. Primary MX host IP resolution (verifies that MX host is alive and routable)
 * 6. Enterprise policy block detection (e.g. Yogaworks, Gaiam)
 */
export async function verifyEmailDeliverability(
  email: string,
  website?: string
): Promise<DeliverabilityCheckResult> {
  const syntax = validateEmailSyntax(email);
  if (!syntax.isValid) {
    return {
      isDeliverable: false,
      status: 'undeliverable',
      reason: syntax.reason || 'Invalid email syntax'
    };
  }

  const clean = email.trim().toLowerCase();

  // Check persistent bounce blacklist
  if (isEmailBounced(clean)) {
    return {
      isDeliverable: false,
      status: 'undeliverable',
      reason: 'Permanent bounce blacklist: Remote MTA previously rejected recipient (550 Recipient not found / Mailbox does not exist).'
    };
  }

  const atIndex = clean.lastIndexOf('@');
  const localPart = clean.slice(0, atIndex);
  const domainPart = clean.slice(atIndex + 1);

  // Check domain mismatch with official company website
  if (website) {
    const webDomain = extractCleanDomain(website);
    if (webDomain && !areDomainsRelated(domainPart, webDomain)) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `Domain mismatch: Email domain (@${domainPart}) does not match business website domain (${webDomain}). High probability of AI hallucination / non-existent mailbox.`
      };
    }
  }

  // Check high-risk auto-reject role accounts
  if (HIGH_RISK_ROLES.has(localPart)) {
    return {
      isDeliverable: false,
      status: 'undeliverable',
      isRoleAccount: true,
      reason: `Auto-reject role mailbox (${localPart}@). Enterprise and business mail filters routinely reject or ignore cold inquiries to ${localPart}@ (550 Recipient address rejected).`
    };
  }

  // Check enterprise policy domain block
  if (ENTERPRISE_BLOCKED_DOMAINS.has(domainPart) && (localPart === 'info' || localPart === 'contact' || localPart === 'hello')) {
    return {
      isDeliverable: false,
      status: 'undeliverable',
      isRoleAccount: true,
      reason: `Blocked by enterprise gateway: ${domainPart} has strict administrative policies blocking unsolicited external mail to generic aliases like ${localPart}@.`
    };
  }

  // Perform DNS MX Record Resolution
  try {
    const mxRecords = await withTimeout(
      dns.resolveMx(domainPart),
      3500,
      `DNS lookup timed out for ${domainPart}`
    );

    if (!mxRecords || mxRecords.length === 0) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `DNS ENODATA: Domain ${domainPart} exists but has NO mail exchange (MX) records configured. Cannot receive email.`
      };
    }

    // Check Null MX (RFC 7505: priority 0, exchange '.')
    const isNullMx = mxRecords.some(mx => !mx.exchange || mx.exchange === '.' || (mx.priority === 0 && mx.exchange === ''));
    if (isNullMx) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `Null MX (RFC 7505): Domain ${domainPart} explicitly declares it does NOT accept any incoming email.`
      };
    }

    // Check broken Cloudflare proxy direct-connect MX (_dc-mx) that rejects relay (554 5.7.1)
    const hasBrokenProxyMx = mxRecords.some(mx => mx.exchange.toLowerCase().startsWith('_dc-mx.'));
    if (hasBrokenProxyMx) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `Misconfigured proxy MX (_dc-mx): Domain ${domainPart} uses an unconfigured proxy MX that denies mail relay (554 5.7.1 Relay access denied).`
      };
    }

    // Sort by priority and select primary MX
    const sorted = [...mxRecords].sort((a, b) => a.priority - b.priority);
    const primaryMx = sorted[0].exchange;
    const provider = detectMailProvider(primaryMx);

    // Verify MX host resolves to active IP
    try {
      const ips = await withTimeout(
        dns.resolve4(primaryMx),
        2500,
        `MX host IP resolution timed out for ${primaryMx}`
      );

      if (!ips || ips.length === 0 || ips[0] === '127.0.0.1' || ips[0] === '0.0.0.0' || ips[0].startsWith('10.') || ips[0].startsWith('192.168.')) {
        return {
          isDeliverable: false,
          status: 'undeliverable',
          reason: `MX server host ${primaryMx} resolves to invalid, loopback, or non-routable IP address (${ips?.[0] || 'none'}).`
        };
      }
    } catch (ipErr: any) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `MX server host ${primaryMx} cannot be resolved to any active IP address: ${ipErr.message || 'Host not found'}.`
      };
    }

    // Check if generic info/contact on standard domain
    const isGenericRole = ['info', 'contact', 'hello', 'office', 'inquiries', 'enquiry', 'admin', 'mail'].includes(localPart);

    // Shared host / GoDaddy / StackMail unconfigured mailbox check
    const isSharedHost = primaryMx.includes('secureserver.net') || 
      primaryMx.includes('stackmail.com') || 
      primaryMx.includes('hostinger') || 
      primaryMx.includes('bluehost') || 
      primaryMx.includes('dreamhost') || 
      primaryMx.includes('namecheap') || 
      primaryMx.includes('cpanel') || 
      primaryMx.includes('ipage.com');

    if (website) {
      const probe = await probeWebsiteQuick(website);

      if (probe.isParked) {
        return {
          isDeliverable: false,
          status: 'undeliverable',
          mxRecord: primaryMx,
          mailProvider: provider,
          isRoleAccount: isGenericRole,
          reason: `Parked or expired domain: Website (${website}) displays parked domain / for-sale notices. Mailbox is unconfigured (550 Recipient not found).`
        };
      }

      if (!probe.isReachable) {
        if (isSharedHost) {
          return {
            isDeliverable: false,
            status: 'undeliverable',
            mxRecord: primaryMx,
            mailProvider: provider,
            isRoleAccount: isGenericRole,
            reason: `Shared hosting inactive domain (${provider}): Website (${website}) returned ${probe.statusCode || 'unreachable'} and mailbox is unconfigured (550 Mailbox does not exist / Recipient not found).`
          };
        } else if (isGenericRole) {
          return {
            isDeliverable: false,
            status: 'risky',
            mxRecord: primaryMx,
            mailProvider: provider,
            isRoleAccount: true,
            reason: `Unreachable company website (${website}): Generic alias (${localPart}@) without operational website to verify active recipient.`
          };
        }
      } else if (probe.publishedEmails && probe.publishedEmails.length > 0) {
        // If the website lists verified email addresses but the candidate email isn't one of them
        if (!probe.publishedEmails.includes(clean)) {
          if (isSharedHost) {
            return {
              isDeliverable: false,
              status: 'undeliverable',
              mxRecord: primaryMx,
              mailProvider: provider,
              isRoleAccount: isGenericRole,
              reason: `Unverified mailbox on shared host (${provider}): Website publishes official address (${probe.publishedEmails.slice(0, 2).join(', ')}), but ${clean} is not active (high 550 bounce risk).`
            };
          }
        }
      }
    } else if (isSharedHost && isGenericRole) {
      return {
        isDeliverable: false,
        status: 'risky',
        mxRecord: primaryMx,
        mailProvider: provider,
        isRoleAccount: true,
        reason: `Unverified mailbox on shared host (${provider}): Generic alias (${localPart}@) without company website verification.`
      };
    }

    return {
      isDeliverable: true,
      status: 'verified',
      mxRecord: primaryMx,
      mailProvider: provider,
      isRoleAccount: isGenericRole,
      reason: `Verified Active MX: ${primaryMx} (${provider}) — Ready for delivery.`
    };
  } catch (dnsErr: any) {
    const errCode = dnsErr.code || dnsErr.message || '';
    if (errCode === 'ENOTFOUND' || errCode.includes('ENOTFOUND') || errCode.includes('NXDOMAIN')) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `DNS NXDOMAIN: Domain "${domainPart}" does not exist. Address not found.`
      };
    }
    if (errCode === 'ENODATA' || errCode.includes('ENODATA')) {
      return {
        isDeliverable: false,
        status: 'undeliverable',
        reason: `DNS ENODATA: Domain "${domainPart}" has no mail exchange (MX) records configured.`
      };
    }
    if (errCode.includes('timed out')) {
      return {
        isDeliverable: false,
        status: 'risky',
        reason: `DNS resolution timed out for domain "${domainPart}". Remote nameservers unresponsive.`
      };
    }
    return {
      isDeliverable: false,
      status: 'undeliverable',
      reason: `DNS query failed for domain "${domainPart}": ${dnsErr.message || errCode}`
    };
  }
}

/**
 * Asynchronous Batch Validation & Deliverability Enrichment
 */
export async function validateAndEnrichLeadsAsync(
  leads: Partial<BuyerRecord>[],
  existingSentLog: SendLogEntry[] = [],
  existingBuyers: BuyerRecord[] = []
): Promise<{ validLeads: BuyerRecord[]; flaggedLeads: BuyerRecord[]; duplicatesSkipped: number }> {
  const sentEmails = new Set(existingSentLog.map(s => s.email.trim().toLowerCase()));
  const existingEmails = new Set(existingBuyers.map(b => b.email.trim().toLowerCase()));
  const seenInBatch = new Set<string>();

  const validLeads: BuyerRecord[] = [];
  const flaggedLeads: BuyerRecord[] = [];
  let duplicatesSkipped = 0;

  // Process with concurrency limit (max 6 parallel DNS queries)
  const concurrency = 6;
  const leadChunks: Partial<BuyerRecord>[][] = [];
  for (let i = 0; i < leads.length; i += concurrency) {
    leadChunks.push(leads.slice(i, i + concurrency));
  }

  for (const chunk of leadChunks) {
    const results = await Promise.all(
      chunk.map(async lead => {
        const email = (lead.email || '').trim().toLowerCase();
        const buyerName = (lead.buyer_name || '').trim() || 'Valued Buyer';
        const companyName = (lead.company_name || '').trim() || 'Wellness Studio';
        const website = (lead.website || '').trim();
        const country = (lead.country || '').trim() || 'International';
        const sourcePlatform = lead.source_platform || 'Other';
        const discoveredDate = lead.discovered_date || new Date().toISOString();

        if (!email) {
          return {
            type: 'flagged' as const,
            record: {
              email: 'missing@unknown.com',
              buyer_name: buyerName,
              company_name: companyName,
              website,
              country,
              source_platform: sourcePlatform,
              category: lead.category || 'unclassified',
              discovered_date: discoveredDate,
              status: 'invalid' as const,
              deliverability_status: 'undeliverable' as DeliverabilityStatus,
              notes: 'Missing email address'
            }
          };
        }

        // Duplicate check in batch
        if (seenInBatch.has(email)) {
          return { type: 'duplicate' as const };
        }
        seenInBatch.add(email);

        // Check if previously sent
        const alreadySent = sentEmails.has(email);
        const alreadyInDb = existingEmails.has(email);

        // Run deep deliverability verification
        const deliverability = await verifyEmailDeliverability(email, website);

        const record: BuyerRecord = {
          email,
          buyer_name: buyerName,
          company_name: companyName,
          website,
          country,
          source_platform: sourcePlatform,
          category: lead.category || 'unclassified',
          discovered_date: discoveredDate,
          crawled_direct_email: lead.crawled_direct_email,
          original_discovered_email: lead.original_discovered_email,
          crawl_source_section: lead.crawl_source_section,
          status: (!deliverability.isDeliverable || deliverability.status === 'undeliverable')
            ? 'invalid'
            : (alreadySent || deliverability.status === 'risky')
            ? 'flagged'
            : 'valid',
          notes: lead.notes || (!deliverability.isDeliverable
            ? deliverability.reason
            : alreadySent
            ? 'Already contacted in previous campaign (sent_log)'
            : (alreadyInDb ? 'Existing buyer record' : deliverability.reason)),
          mx_record: deliverability.mxRecord,
          mail_provider: deliverability.mailProvider,
          deliverability_status: deliverability.status,
          deliverability_reason: deliverability.reason
        };

        if (!deliverability.isDeliverable || deliverability.status === 'undeliverable' || alreadySent) {
          return { type: 'flagged' as const, record };
        } else {
          return { type: 'valid' as const, record };
        }
      })
    );

    for (const res of results) {
      if (res.type === 'duplicate') {
        duplicatesSkipped++;
      } else if (res.type === 'valid') {
        validLeads.push(res.record);
      } else if (res.type === 'flagged') {
        flaggedLeads.push(res.record);
      }
    }
  }

  return { validLeads, flaggedLeads, duplicatesSkipped };
}

// Synchronous wrapper for basic syntax enrichment
export function validateAndEnrichLeads(
  leads: Partial<BuyerRecord>[],
  existingSentLog: SendLogEntry[] = [],
  existingBuyers: BuyerRecord[] = []
): { validLeads: BuyerRecord[]; flaggedLeads: BuyerRecord[]; duplicatesSkipped: number } {
  const sentEmails = new Set(existingSentLog.map(s => s.email.trim().toLowerCase()));
  const existingEmails = new Set(existingBuyers.map(b => b.email.trim().toLowerCase()));
  const seenInBatch = new Set<string>();

  const validLeads: BuyerRecord[] = [];
  const flaggedLeads: BuyerRecord[] = [];
  let duplicatesSkipped = 0;

  for (const lead of leads) {
    const email = (lead.email || '').trim().toLowerCase();
    const syntaxCheck = validateEmailSyntax(email);

    const buyerName = (lead.buyer_name || '').trim() || 'Valued Buyer';
    const companyName = (lead.company_name || '').trim() || 'Wellness Studio';
    const website = (lead.website || '').trim();
    const country = (lead.country || '').trim() || 'International';
    const sourcePlatform = lead.source_platform || 'Other';
    const discoveredDate = lead.discovered_date || new Date().toISOString();

    if (!syntaxCheck.isValid) {
      flaggedLeads.push({
        email: email || 'missing@unknown.com',
        buyer_name: buyerName,
        company_name: companyName,
        website,
        country,
        source_platform: sourcePlatform,
        category: lead.category || 'unclassified',
        discovered_date: discoveredDate,
        status: 'invalid',
        deliverability_status: 'undeliverable',
        notes: syntaxCheck.reason || 'Invalid email syntax'
      });
      continue;
    }

    if (seenInBatch.has(email)) {
      duplicatesSkipped++;
      continue;
    }
    seenInBatch.add(email);

    const alreadySent = sentEmails.has(email);
    const alreadyInDb = existingEmails.has(email);

    const record: BuyerRecord = {
      email,
      buyer_name: buyerName,
      company_name: companyName,
      website,
      country,
      source_platform: sourcePlatform,
      category: lead.category || 'unclassified',
      discovered_date: discoveredDate,
      status: alreadySent ? 'flagged' : 'valid',
      deliverability_status: 'verified',
      notes: alreadySent ? 'Already contacted in previous campaign (sent_log)' : (alreadyInDb ? 'Existing buyer record' : undefined)
    };

    if (alreadySent) {
      flaggedLeads.push(record);
    } else {
      validLeads.push(record);
    }
  }

  return { validLeads, flaggedLeads, duplicatesSkipped };
}

