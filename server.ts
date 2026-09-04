import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';
import {
  readBuyers,
  writeBuyers,
  readBusinessEmails,
  readIndividualEmails,
  readSentLog,
  readSettings,
  writeSettings,
  getDatabaseStats,
  getLatestReport,
  setLatestReport,
  escapeCSVField,
  parseCSV,
  clearAllData,
  readBouncedEmails,
  recordBouncedEmail
} from './server/dataStore.ts';
import { validateAndEnrichLeads, validateAndEnrichLeadsAsync, validateEmailSyntax, verifyEmailDeliverability } from './server/emailValidator.ts';
import { searchBuyers, scrapeUrlForEmails } from './server/searchAdapters.ts';
import { runClassificationPipeline } from './server/classifier.ts';
import { executeCampaign, interpolateTemplate, tailorMessageWithGemini } from './server/outreachSender.ts';
import { BuyerRecord } from './src/types.ts';

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // ==========================================
  // API ROUTES (Section 8 & Core Modules)
  // ==========================================

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Database Stats
  app.get('/api/stats', (req, res) => {
    try {
      const stats = getDatabaseStats();
      res.json(stats);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Settings
  app.get('/api/settings', (req, res) => {
    try {
      const settings = readSettings();
      // Mask password for display
      const safe = {
        ...settings,
        has_password: Boolean(settings.app_password && settings.app_password.trim().length > 0),
        app_password: settings.app_password ? '••••••••••••••••' : ''
      };
      res.json(safe);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/settings', (req, res) => {
    try {
      const newSettings = req.body;
      // Don't overwrite password if masked
      if (newSettings.app_password === '••••••••••••••••') {
        delete newSettings.app_password;
      }
      const updated = writeSettings(newSettings);
      res.json({
        ...updated,
        has_password: Boolean(updated.app_password && updated.app_password.trim().length > 0),
        app_password: updated.app_password ? '••••••••••••••••' : ''
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Buyers list
  app.get('/api/buyers', (req, res) => {
    try {
      let buyers = readBuyers();
      const { category, status, platform, search } = req.query;

      if (category && typeof category === 'string' && category !== 'all') {
        buyers = buyers.filter(b => b.category === category);
      }
      if (status && typeof status === 'string' && status !== 'all') {
        buyers = buyers.filter(b => b.status === status);
      }
      if (platform && typeof platform === 'string' && platform !== 'all') {
        buyers = buyers.filter(b => b.source_platform.toLowerCase() === platform.toLowerCase());
      }
      if (search && typeof search === 'string') {
        const query = search.toLowerCase();
        buyers = buyers.filter(b =>
          b.email.toLowerCase().includes(query) ||
          b.buyer_name.toLowerCase().includes(query) ||
          b.company_name.toLowerCase().includes(query) ||
          b.country.toLowerCase().includes(query)
        );
      }

      res.json(buyers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add buyer lead
  app.post('/api/buyers', async (req, res) => {
    try {
      const { email, buyer_name, company_name, website, country, source_platform, category } = req.body;
      const current = readBuyers();
      const sentLog = readSentLog();

      const cleanEmail = (email || '').trim().toLowerCase();
      const deliverability = await verifyEmailDeliverability(cleanEmail, website);

      const existsIndex = current.findIndex(b => b.email.toLowerCase() === cleanEmail);
      const isSent = sentLog.some(s => s.email.toLowerCase() === cleanEmail);

      const newRecord: BuyerRecord = {
        email: cleanEmail,
        buyer_name: buyer_name || 'Valued Buyer',
        company_name: company_name || 'Wellness Center',
        website: website || '',
        country: country || 'International',
        source_platform: source_platform || 'Other',
        category: category || 'unclassified',
        discovered_date: new Date().toISOString(),
        status: !deliverability.isDeliverable ? 'invalid' : (isSent ? 'flagged' : 'valid'),
        notes: deliverability.reason,
        mx_record: deliverability.mxRecord,
        mail_provider: deliverability.mailProvider,
        deliverability_status: deliverability.status,
        deliverability_reason: deliverability.reason
      };

      if (existsIndex >= 0) {
        current[existsIndex] = newRecord;
      } else {
        current.unshift(newRecord);
      }

      writeBuyers(current);
      res.json(newRecord);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete buyer
  app.delete('/api/buyers/:email', (req, res) => {
    try {
      const email = decodeURIComponent(req.params.email).toLowerCase();
      const current = readBuyers();
      const filtered = current.filter(b => b.email.toLowerCase() !== email);
      writeBuyers(filtered);
      res.json({ success: true, count: filtered.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Multi-Source Buyer Search Module (Section 5.1 & Algorithm 12.1)
  app.post('/api/search', async (req, res) => {
    try {
      const { keyword, sources, country, maxResults, autoSave } = req.body;
      const searchResult = await searchBuyers({
        keyword: keyword || 'Singing Bowls',
        sources: sources || ['Google', 'Facebook', 'LinkedIn', 'Directory', 'Website'],
        country,
        maxResults: Number(maxResults) || 8
      });

      const discoveredLeads = searchResult.leads || [];
      const currentBuyers = readBuyers();
      const sentLog = readSentLog();

      const { validLeads, flaggedLeads, duplicatesSkipped } = await validateAndEnrichLeadsAsync(
        discoveredLeads,
        sentLog,
        currentBuyers
      );

      if (autoSave && validLeads.length > 0) {
        const existingEmails = new Set(currentBuyers.map(b => b.email.toLowerCase()));
        const toAdd = validLeads.filter(b => !existingEmails.has(b.email.toLowerCase()));
        if (toAdd.length > 0) {
          writeBuyers([...toAdd, ...currentBuyers]);
        }
      }

      res.json({
        totalDiscovered: discoveredLeads.length,
        validLeads,
        flaggedLeads,
        duplicatesSkipped,
        allDiscovered: discoveredLeads,
        status: searchResult.status,
        message: searchResult.message
      });
    } catch (err: any) {
      console.error('Search error:', err);
      res.status(500).json({ 
        totalDiscovered: 0,
        validLeads: [],
        flaggedLeads: [],
        duplicatesSkipped: 0,
        allDiscovered: [],
        status: 'error',
        message: err.message || 'An unexpected error occurred during search' 
      });
    }
  });

  // Website URL scraper
  app.post('/api/scrape-url', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: 'URL is required' });
      }
      const result = await scrapeUrlForEmails(url);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Live Single Email Deliverability Verification Test
  app.post('/api/verify-single-email', async (req, res) => {
    try {
      const { email, website } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      const result = await verifyEmailDeliverability(email, website);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Email Deliverability & MX Validation Module (Section 5.3 & Algorithm 12.1)
  app.post('/api/validate-emails', async (req, res) => {
    try {
      const buyers = readBuyers();
      const sentLog = readSentLog();
      const existingSentEmails = new Set(sentLog.map(s => s.email.toLowerCase()));

      let validCount = 0;
      let flaggedCount = 0;
      let undeliverableCount = 0;
      let duplicatesFound = 0;

      // Concurrently verify deliverability with max 6 queries at a time
      const concurrency = 6;
      const chunks: BuyerRecord[][] = [];
      for (let i = 0; i < buyers.length; i += concurrency) {
        chunks.push(buyers.slice(i, i + concurrency));
      }

      const updated: BuyerRecord[] = [];

      for (const chunk of chunks) {
        const verifiedChunk = await Promise.all(
          chunk.map(async b => {
            const isSent = existingSentEmails.has(b.email.toLowerCase());
            const check = await verifyEmailDeliverability(b.email, b.website);

            if (!check.isDeliverable || check.status === 'undeliverable') {
              undeliverableCount++;
              return {
                ...b,
                status: 'invalid' as const,
                deliverability_status: 'undeliverable' as const,
                deliverability_reason: check.reason,
                notes: check.reason,
                mx_record: check.mxRecord,
                mail_provider: check.mailProvider
              };
            } else if (isSent) {
              duplicatesFound++;
              return {
                ...b,
                status: 'flagged' as const,
                deliverability_status: check.status,
                deliverability_reason: check.reason,
                notes: 'Already contacted in previous campaign',
                mx_record: check.mxRecord,
                mail_provider: check.mailProvider
              };
            } else if (check.status === 'risky') {
              flaggedCount++;
              return {
                ...b,
                status: 'flagged' as const,
                deliverability_status: 'risky' as const,
                deliverability_reason: check.reason,
                notes: check.reason,
                mx_record: check.mxRecord,
                mail_provider: check.mailProvider
              };
            } else {
              validCount++;
              return {
                ...b,
                status: 'valid' as const,
                deliverability_status: 'verified' as const,
                deliverability_reason: check.reason,
                notes: check.reason,
                mx_record: check.mxRecord,
                mail_provider: check.mailProvider
              };
            }
          })
        );
        updated.push(...verifiedChunk);
      }

      writeBuyers(updated);

      res.json({
        total: updated.length,
        validCount,
        undeliverableCount,
        flaggedCount,
        duplicatesFound,
        leads: updated
      });
    } catch (err: any) {
      console.error('Validation error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // AI Email Classification Module (Section 5.4 & Algorithm 12.2)
  app.post('/api/classify', async (req, res) => {
    try {
      const { targetEmails } = req.body;
      const result = await runClassificationPipeline(targetEmails);
      res.json(result);
    } catch (err: any) {
      console.error('Classification error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Send Campaign Module (Section 5.5 & Algorithm 12.3)
  app.post('/api/send-campaign', async (req, res) => {
    try {
      const {
        subject,
        body,
        audience = 'all',
        attach_presentation = true,
        delay_seconds = 2,
        simulation_mode,
        selected_emails,
        ai_tailor_content = false
      } = req.body;

      if (!subject || !body) {
        return res.status(400).json({ error: 'Subject and email body are required.' });
      }

      const report = await executeCampaign({
        subject,
        body,
        audience,
        attach_presentation,
        delay_seconds: Number(delay_seconds),
        simulation_mode,
        selected_emails,
        ai_tailor_content
      });

      res.json(report);
    } catch (err: any) {
      console.error('Send campaign error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Preview Personalized Email
  app.post('/api/preview-email', async (req, res) => {
    try {
      const { subject, body, email, ai_tailor } = req.body;
      const buyers = readBuyers();
      const buyer = buyers.find(b => b.email.toLowerCase() === (email || '').toLowerCase()) || {
        email: email || 'buyer@soundstudio.com',
        buyer_name: 'Elena Vance',
        company_name: 'Sound Oasis Sanctuary',
        country: 'United States',
        website: 'https://soundoasis.org',
        category: 'business' as const,
        source_platform: 'Google' as const,
        discovered_date: new Date().toISOString(),
        status: 'valid' as const
      };

      if (ai_tailor && process.env.GEMINI_API_KEY) {
        const tailored = await tailorMessageWithGemini(subject, body, buyer);
        return res.json({ subject: tailored.subject, body: tailored.body, recipient: buyer });
      }

      const finalSubject = interpolateTemplate(subject, buyer);
      const finalBody = interpolateTemplate(body, buyer);
      res.json({ subject: finalSubject, body: finalBody, recipient: buyer });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sent Log
  app.get('/api/sent-log', (req, res) => {
    try {
      const logs = readSentLog();
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get Bounced Email Registry
  app.get('/api/bounces', (req, res) => {
    try {
      const bounces = readBouncedEmails();
      res.json({
        bounces: Object.values(bounces),
        count: Object.keys(bounces).length
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Report Single Bounced Email (Permanent MTA rejection)
  app.post('/api/bounces/report', (req, res) => {
    try {
      const { email, reason } = req.body;
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      const result = recordBouncedEmail(email, reason || 'Remote MTA 550 Recipient rejected / Mailbox does not exist');
      res.json({ success: true, email, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Parse Bounce Delivery Failure Report (Paste from Gmail / Mailer-Daemon)
  app.post('/api/bounces/parse', (req, res) => {
    try {
      const { text } = req.body;
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ error: 'Text content is required' });
      }

      // Extract all email addresses mentioned in the bounce text
      const emailMatches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
      const cleanEmails = Array.from(new Set(emailMatches.map(e => e.trim().toLowerCase())));

      // Filter out sender's own address if present
      const settings = readSettings();
      const senderEmail = (settings.email || '').toLowerCase();
      const recipientBounces = cleanEmails.filter(e => e !== senderEmail && !e.includes('mailer-daemon') && !e.includes('postmaster'));

      // Extract error status line if available
      let detectedReason = 'Remote MTA bounce: 550 Recipient not found / Mailbox does not exist';
      if (text.includes('550 5.1.0 Recipient not found')) {
        detectedReason = 'Remote MTA bounce: 550 5.1.0 Recipient not found';
      } else if (text.includes('550 Mailbox does not exist')) {
        detectedReason = 'Remote MTA bounce: 550 Mailbox does not exist';
      } else if (text.includes('554 5.7.1') || text.includes('Relay access denied')) {
        detectedReason = 'Remote MTA bounce: 554 5.7.1 Relay access denied';
      } else if (text.includes('Address not found')) {
        detectedReason = 'Remote MTA bounce: Address not found or unable to receive email';
      } else if (text.includes('Message blocked')) {
        detectedReason = 'Remote MTA bounce: Message blocked by recipient enterprise policy';
      }

      const processed: { email: string; updatedBuyers: number; updatedSentLogs: number }[] = [];
      for (const email of recipientBounces) {
        const res = recordBouncedEmail(email, detectedReason);
        processed.push({ email, ...res });
      }

      res.json({
        success: true,
        detectedReason,
        count: processed.length,
        processed
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Current Campaign Report
  app.get('/api/report', (req, res) => {
    try {
      const report = getLatestReport();
      const sentLog = readSentLog();
      const totalSent = sentLog.filter(s => s.status === 'sent').length;
      const totalFailed = sentLog.filter(s => s.status === 'failed').length;
      const totalSkipped = sentLog.filter(s => s.status === 'skipped_duplicate').length;

      res.json({
        latestReport: report,
        cumulativeStats: {
          total_logged: sentLog.length,
          sent: totalSent,
          failed: totalFailed,
          skipped: totalSkipped,
          success_rate: sentLog.length > 0 ? Math.round((totalSent / sentLog.length) * 100) : 0
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Upload CSV (Section 8: /upload)
  app.post('/api/upload-csv', async (req, res) => {
    try {
      const { csvText, autoValidate = true } = req.body;
      if (!csvText || typeof csvText !== 'string') {
        return res.status(400).json({ error: 'No CSV content provided.' });
      }

      const rows = parseCSV(csvText);
      if (rows.length === 0) {
        return res.status(400).json({ error: 'CSV file contains no valid data rows.' });
      }

      const rawLeads: Partial<BuyerRecord>[] = rows.map(r => ({
        email: r.email || r.email_address || r.Email || r['E-mail'] || '',
        buyer_name: r.buyer_name || r.name || r.Name || r['Contact Name'] || 'Valued Buyer',
        company_name: r.company_name || r.company || r.Company || r['Business Name'] || 'Singing Bowls Prospect',
        website: r.website || r.Website || r.url || '',
        country: r.country || r.Country || 'International',
        source_platform: (r.source_platform as any) || 'Other',
        category: (r.category as any) || 'unclassified'
      })).filter(l => l.email && l.email.length > 0);

      const currentBuyers = readBuyers();
      const sentLog = readSentLog();

      const { validLeads, flaggedLeads, duplicatesSkipped } = autoValidate
        ? await validateAndEnrichLeadsAsync(rawLeads, sentLog, currentBuyers)
        : validateAndEnrichLeads(rawLeads, sentLog, currentBuyers);

      const existingMap = new Map(currentBuyers.map(b => [b.email.toLowerCase(), b]));
      let addedCount = 0;
      let updatedCount = 0;

      for (const lead of [...validLeads, ...flaggedLeads]) {
        const key = lead.email.toLowerCase();
        if (existingMap.has(key)) {
          existingMap.set(key, { ...existingMap.get(key)!, ...lead });
          updatedCount++;
        } else {
          existingMap.set(key, lead);
          addedCount++;
        }
      }

      const combined = Array.from(existingMap.values());
      writeBuyers(combined);

      res.json({
        totalParsed: rawLeads.length,
        addedCount,
        updatedCount,
        validCount: validLeads.length,
        flaggedCount: flaggedLeads.length,
        duplicatesSkipped
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Download Report CSV (Section 8: /download-report)
  app.get('/api/download-report', (req, res) => {
    try {
      const report = getLatestReport();
      const sentLog = readSentLog();

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="outreach_campaign_report.csv"');

      if (!report && sentLog.length === 0) {
        return res.send('delivery_id,email,buyer_name,company_name,status,sent_at,response_message\n');
      }

      const headers = ['delivery_id', 'campaign_id', 'email', 'buyer_name', 'company_name', 'status', 'sent_at', 'response_message'];
      const lines = [headers.join(',')];

      sentLog.forEach(s => {
        lines.push([
          escapeCSVField(s.delivery_id),
          escapeCSVField(s.campaign_id),
          escapeCSVField(s.email),
          escapeCSVField(s.buyer_name),
          escapeCSVField(s.company_name),
          escapeCSVField(s.status),
          escapeCSVField(s.sent_at),
          escapeCSVField(s.response_message)
        ].join(','));
      });

      res.send(lines.join('\n'));
    } catch (err: any) {
      res.status(500).send('Error generating report');
    }
  });

  // Download Store CSVs: buyers.csv, business_emails.csv, individual_emails.csv, sent_log.csv
  app.get('/api/download-csv/:type', (req, res) => {
    try {
      const { type } = req.params;
      const dataDir = path.join(process.cwd(), 'data');
      let targetFile = '';
      let filename = 'export.csv';

      if (type === 'buyers') {
        targetFile = path.join(dataDir, 'buyers.csv');
        filename = 'singing_bowls_buyers.csv';
      } else if (type === 'business') {
        targetFile = path.join(dataDir, 'business_emails.csv');
        filename = 'singing_bowls_business_emails.csv';
      } else if (type === 'individual') {
        targetFile = path.join(dataDir, 'individual_emails.csv');
        filename = 'singing_bowls_individual_emails.csv';
      } else if (type === 'sent_log') {
        targetFile = path.join(dataDir, 'sent_log.csv');
        filename = 'singing_bowls_sent_log.csv';
      } else {
        return res.status(404).send('Invalid file type');
      }

      if (!fs.existsSync(targetFile)) {
        return res.status(404).send('File not found');
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.sendFile(targetFile);
    } catch (err: any) {
      res.status(500).send('Error downloading file');
    }
  });

  // Presentation File Download / Inspection
  app.get('/api/presentation', (req, res) => {
    const settings = readSettings();
    let presPath = path.resolve(process.cwd(), settings.presentation_path || 'assets/Export_API_documentation.docx.pdf');

    if (!fs.existsSync(presPath)) {
      const fallbackA = path.resolve(process.cwd(), 'assets/Export_API_documentation.docx.pdf');
      if (fs.existsSync(fallbackA)) {
        presPath = fallbackA;
      }
    }

    if (fs.existsSync(presPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${settings.presentation_filename || path.basename(presPath)}"`);
      res.sendFile(presPath);
    } else {
      res.status(404).send('Presentation file not found at ' + presPath);
    }
  });

  // Clear all sample and operational data (Buyers, Classifications, Sent Log)
  app.post('/api/clear-data', (req, res) => {
    try {
      clearAllData();
      res.json({ success: true, message: 'All buyer, classification, and sent log records cleared successfully.' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // VITE MIDDLEWARE SETUP
  // ==========================================
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Export Automation Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
