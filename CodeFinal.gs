/**
 * Session Scheduler — Google Apps Script + Zoom (single Pro/Business account)
 *
 * What it does
 *  - Serves a booking page (web app) showing the combined availability of all associates.
 *    Availability = time inside events titled "Interview availability" (see CONFIG) on each
 *    associate's Google Calendar, minus anything else they're busy with.
 *  - When a participant books, assigns the session to the free associate with the fewest
 *    bookings so far (ties go to whoever was booked least recently).
 *  - Creates a unique Zoom meeting under the one shared Zoom account and sends a Google
 *    Calendar invite (with the Zoom join link) to the participant and the associate.
 *  - Never allows more than MAX_CONCURRENT sessions at once (the Zoom account's limit).
 *  - Background job (every 5 minutes):
 *      · reminders to the participant (day before, hour before) and associate (day before)
 *      · a fresh Zoom *host* link to the associate shortly before each session
 *      · after each session, checks Zoom for attendance and sends the participant a
 *        thank-you (attended) or a rebooking email (no-show)
 *      · cancellations: set a booking's Status to "Cancel" in the sheet
 *
 * Everything the client may want to change (names, wording, booking rules, email text) is
 * edited in the Sheet's "Customization" tab, which setup creates. The values in CONFIG and
 * TEMPLATES below are only the defaults used to fill that tab, and the fallback if a cell is
 * blank or invalid.
 * See README.md for setup.
 */

// ───────────────────────────── Configuration (defaults) ─────────────────────────────
const CONFIG = {
  COMPANY_NAME: 'Wise Planet',
  SERVICE_NAME: 'your recent session with us',      // used in emails: "your experience with {{service}}"
  SESSION_TITLE: 'Feedback Survey',       // what a session is called on the page, invites and emails
  PAGE_INTRO: "We'd love to hear about your experience. Pick a time that works for you.",
  ADMIN_NAME: 'Lucy Claire Curran',           // named in associate emails: "let {{admin_name}} know"
  INVITE_HOST_LABEL: 'Interviewer', // label for the associate's name in the calendar invite
  REPLY_TO: '',                     // replies to automated emails go here (blank = the scheduler account)
  BOOKING_URL: '',                  // the web app URL, used in the rebooking email (or set Script property BOOKING_URL)

  INTERVIEW_MINUTES: 60,
  AVAILABILITY_KEYWORD: 'Interview availability', // calendar events whose title contains this are bookable windows
  BUFFER_MINUTES: 0,                // gap kept free before/after every session
  SLOT_STEP_MINUTES: 60,            // how often slots start inside a window (counted from the window's start)
  MAX_CONCURRENT: 2,                // sessions the Zoom account can host at the same time
  BOOKING_WINDOW_DAYS: 14,          // how far ahead participants can book
  MIN_NOTICE_HOURS: 24,             // earliest bookable time, measured from now

  REQUIRE_RECORDING_CONSENT: true,
  CONSENT_TEXT: 'I agree to this session being recorded and transcribed.',
  BUTTON_LABEL: 'Confirm',
  CONFIRM_TITLE: "You're booked",
  CONFIRM_TEXT: "A calendar invite with the Zoom link is on its way to your email, and we'll send a reminder before the session. When you join, you'll wait briefly in a waiting room until we let you in.",

  HOST_LINK_LEAD_MINUTES: 15,       // send the associate's host link this long before start
  SEND_PARTICIPANT_DAY_BEFORE: true,
  SEND_PARTICIPANT_HOUR_BEFORE: true,
  SEND_ASSOCIATE_DAY_BEFORE: true,
  SEND_ASSOCIATE_CONFIRMATIONS: true, // email the associate when a session is booked or cancelled
  SEND_FOLLOW_UP: true,             // thank-you or missed-session email after each session
  FOLLOW_UP_AFTER_MINUTES: 30,      // how long after the scheduled end to check attendance
};

// ───────────────────────────── Email templates ─────────────────────────────
// Plain text. **text** becomes bold and links become clickable in the HTML version.
// Placeholders: {{company}} {{service}} {{session}} {{participant_name}} {{participant_first_name}}
// {{associate_name}} {{associate_first_name}} {{date_time}} {{time}} {{duration}} {{zoom_link}}
// {{passcode}} {{booking_link}} {{admin_name}}   ({{host_link}} only in HOST_LINK)
const TEMPLATES = {
  PARTICIPANT_DAY_BEFORE: {
    subject: 'Tomorrow: your conversation with {{company}}',
    body:
`Hi {{participant_first_name}},

A quick reminder that your session with {{company}} is tomorrow:

**{{date_time}}** ({{duration}} minutes)
Join on Zoom: {{zoom_link}}
Passcode: {{passcode}}

We'll be asking about your experience with {{service}}: what's worked, what hasn't, and what you'd change. There are no right or wrong answers, and you don't need to prepare anything.

As a reminder, the session will be recorded and transcribed so we can focus on the conversation rather than taking notes.

If the time no longer works, just reply to this email and we'll find another.

Thanks,
The {{company}} team`,
  },

  PARTICIPANT_HOUR_BEFORE: {
    subject: 'Starting in 1 hour: {{company}} session',
    body:
`Hi {{participant_first_name}},

Your session starts at **{{time}}**.

Join on Zoom: {{zoom_link}}
Passcode: {{passcode}}

You can join from the Zoom app or your browser, and you don't need a Zoom account. You'll wait briefly in a waiting room until {{associate_first_name}} lets you in. A quiet spot and headphones help, but aren't required.

See you soon,
The {{company}} team`,
  },

  ASSOCIATE_DAY_BEFORE: {
    subject: 'Tomorrow: session with {{participant_name}} at {{time}}',
    body:
`Hi {{associate_first_name}},

You have a session tomorrow:

**{{participant_name}}**, {{date_time}} ({{duration}} minutes)

Your host link will arrive by email about 15 minutes before the start. Use that link, not the one in the calendar invite, so you have host controls for recording and admitting the participant.

If you can't make it, let {{admin_name}} know as soon as possible so the session can be reassigned.`,
  },

  HOST_LINK: {
    subject: 'Host link: {{participant_name}} at {{time}}',
    body:
`Hi {{associate_first_name}},

Your session with **{{participant_name}}** starts {{date_time}}.

{{host_link}}

This link expires a few hours after it was sent and makes you the host, so please don't forward it. The participant will be in the waiting room; admit them once you're in, and start the recording.`,
  },

  ASSOCIATE_BOOKED: {
    subject: 'New session booked: {{participant_name}}, {{date_time}}',
    body:
`Hi {{associate_first_name}},

A new session has been booked with you:

**{{participant_name}}**
{{date_time}} ({{duration}} minutes)

It's on your calendar. About 15 minutes before the start, you'll get a separate email with your host link. Use that link to start the meeting so you have host controls.

If you can't make it, let {{admin_name}} know as soon as possible so the session can be reassigned.`,
  },

  ASSOCIATE_CANCELLED: {
    subject: 'Cancelled: session with {{participant_name}}, {{date_time}}',
    body:
`Hi {{associate_first_name}},

Your session with **{{participant_name}}** on {{date_time}} has been cancelled. It's been removed from your calendar, and the Zoom meeting has been deleted.

No action is needed.`,
  },

  PARTICIPANT_THANK_YOU: {
    subject: 'Thank you for talking with us',
    body:
`Hi {{participant_first_name}},

Thank you for taking the time to talk with {{associate_first_name}} today. Hearing directly from the people we work with is really the most valuable input we get, and your perspective will shape what we do next.

If anything else comes to mind after our conversation, feel free to reply to this email. We read every response.

With thanks,
The {{company}} team`,
  },

  PARTICIPANT_MISSED: {
    subject: 'Sorry we missed you',
    body:
`Hi {{participant_first_name}},

It looks like we weren't able to connect for your session today. No problem, these things happen.

If you'd still like to share your experience, you can pick a new time here: {{booking_link}}

Thanks,
The {{company}} team`,
  },
};

// ───────────────────────────── Customization tab ─────────────────────────────
// Layout of the "Customization" tab: sections, then [key, label, note] rows.
// Keys are CONFIG names, or EMAIL:<TEMPLATE>:subject / EMAIL:<TEMPLATE>:body.
const CUSTOMIZATION_LAYOUT = [
  ['NAMES & CONTACTS', [
    ['COMPANY_NAME', 'Company name', 'Page title, email sender name, invite titles'],
    ['SESSION_TITLE', 'What a session is called', 'Shown on the booking page and in invites, e.g. "Feedback Survey"'],
    ['SERVICE_NAME', 'What participants are giving feedback on', 'Fills "your experience with ___" in emails'],
    ['ADMIN_NAME', 'Admin contact name', 'Who associates contact if they can\'t make a session'],
    ['REPLY_TO', 'Reply-to email address', 'Where participant replies go. Leave blank to use the scheduler account'],
  ]],
  ['BOOKING PAGE', [
    ['PAGE_INTRO', 'Intro text', 'First line under the page heading'],
    ['REQUIRE_RECORDING_CONSENT', 'Require recording consent', 'Checked = participants must tick the consent box to book'],
    ['CONSENT_TEXT', 'Consent checkbox text', ''],
    ['BUTTON_LABEL', 'Booking button label', ''],
    ['CONFIRM_TITLE', 'Confirmation heading', 'Shown after someone books'],
    ['CONFIRM_TEXT', 'Confirmation message', 'Shown after someone books'],
  ]],
  ['CALENDAR INVITE', [
    ['INVITE_HOST_LABEL', 'Label for the associate', 'Appears as "<label>: <associate name>" in the invite, e.g. Interviewer, Host'],
  ]],
  ['SCHEDULING RULES', [
    ['INTERVIEW_MINUTES', 'Session length (minutes)', ''],
    ['SLOT_STEP_MINUTES', 'Start times offered every (minutes)', 'Counted from the start of each availability window'],
    ['BUFFER_MINUTES', 'Buffer between sessions (minutes)', '0 = back-to-back allowed'],
    ['BOOKING_WINDOW_DAYS', 'How far ahead people can book (days)', ''],
    ['MIN_NOTICE_HOURS', 'Minimum notice (hours)', 'Earliest a session can start after booking'],
    ['MAX_CONCURRENT', 'Max sessions at the same time', 'Zoom account limit'],
    ['AVAILABILITY_KEYWORD', 'Availability event title', 'Associates title their calendar windows with this. Changing it means renaming their events'],
  ]],
  ['AUTOMATIC EMAILS: ON/OFF AND TIMING', [
    ['SEND_ASSOCIATE_CONFIRMATIONS', 'Associate: booked / cancelled emails', ''],
    ['SEND_ASSOCIATE_DAY_BEFORE', 'Associate: day-before reminder', ''],
    ['SEND_PARTICIPANT_DAY_BEFORE', 'Participant: day-before reminder', ''],
    ['SEND_PARTICIPANT_HOUR_BEFORE', 'Participant: hour-before reminder', ''],
    ['SEND_FOLLOW_UP', 'Participant: thank-you / missed-session email', ''],
    ['HOST_LINK_LEAD_MINUTES', 'Host link sent this many minutes before', ''],
    ['FOLLOW_UP_AFTER_MINUTES', 'Follow-up sent this many minutes after the end', ''],
  ]],
  ['LINKS', [
    ['BOOKING_URL', 'Booking page link', 'Used in the missed-session email. Leave blank to use the BOOKING_URL script property'],
  ]],
  ['EMAIL WORDING', [
    ['EMAIL:ASSOCIATE_BOOKED', 'Associate: new session booked', 'Sent as soon as someone books'],
    ['EMAIL:ASSOCIATE_CANCELLED', 'Associate: session cancelled', 'Sent when Status is set to Cancel'],
    ['EMAIL:ASSOCIATE_DAY_BEFORE', 'Associate: day-before reminder', ''],
    ['EMAIL:HOST_LINK', 'Associate: host link', 'Sent shortly before the start. {{host_link}} becomes the "Start the meeting as host" link'],
    ['EMAIL:PARTICIPANT_DAY_BEFORE', 'Participant: day-before reminder', ''],
    ['EMAIL:PARTICIPANT_HOUR_BEFORE', 'Participant: hour-before reminder', ''],
    ['EMAIL:PARTICIPANT_THANK_YOU', 'Participant: thank-you', 'After a completed session'],
    ['EMAIL:PARTICIPANT_MISSED', 'Participant: missed session', 'After a no-show; include {{booking_link}}'],
  ]],
];

const PLACEHOLDER_HELP = 'Placeholders for email wording (keep the double braces): {{company}} {{service}} {{session}} ' +
  '{{participant_name}} {{participant_first_name}} {{associate_name}} {{associate_first_name}} {{date_time}} {{time}} ' +
  '{{duration}} {{zoom_link}} {{passcode}} {{booking_link}} {{admin_name}}. Wrap text in **double asterisks** for bold. ' +
  'Inside a cell, press Ctrl/Cmd + Enter for a new line.';

let SETTINGS_LOADED_ = false;

/** Applies one Customization value to CONFIG or TEMPLATES. Blank or invalid values keep the default. */
function applyCustomValue_(key, raw) {
  const m = /^EMAIL:(\w+):(subject|body)$/.exec(key);
  if (m) {
    if (!(m[1] in TEMPLATES) || !String(raw).trim()) return;
    const patch = {};
    patch[m[2]] = m[2] === 'body' ? String(raw).replace(/\r\n/g, '\n') : String(raw).trim();
    TEMPLATES[m[1]] = Object.assign({}, TEMPLATES[m[1]], patch);
    return;
  }
  if (!(key in CONFIG)) return;
  const def = CONFIG[key];
  if (typeof def === 'boolean') {
    if (raw === true || raw === false) CONFIG[key] = raw;
    else if (/^(true|yes|on)$/i.test(String(raw).trim())) CONFIG[key] = true;
    else if (/^(false|no|off)$/i.test(String(raw).trim())) CONFIG[key] = false;
  } else if (typeof def === 'number') {
    const n = Number(raw);
    if (raw !== '' && isFinite(n) && n >= 0) CONFIG[key] = n;
    else if (raw !== '') console.warn('Customization: "' + key + '" must be a number; using ' + def);
  } else if (String(raw).trim() !== '' || key === 'REPLY_TO' || key === 'BOOKING_URL') {
    CONFIG[key] = String(raw).trim();
  }
}

/**
 * Overrides CONFIG and TEMPLATES with the values in the "Customization" tab.
 * Called at the start of every entry point.
 */
function loadSettings_() {
  if (SETTINGS_LOADED_) return;
  SETTINGS_LOADED_ = true;
  let ss;
  try { ss = spreadsheet_(); } catch (e) { return; }
  const sh = ss.getSheetByName(SHEETS.CUSTOMIZATION);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
      const key = String(r[0]).trim();
      if (key) applyCustomValue_(key, r[2]);
    });
  } else {
    loadLegacyTabs_(ss); // older versions used separate Settings / Email Templates tabs
  }
}

/** Reads the older "Settings" and "Email Templates" tabs, if present. */
function loadLegacyTabs_(ss) {
  const st = ss.getSheetByName('Settings');
  if (st && st.getLastRow() > 1) {
    st.getRange(2, 1, st.getLastRow() - 1, 2).getValues().forEach(r => applyCustomValue_(String(r[0]).trim(), r[1]));
  }
  const tt = ss.getSheetByName('Email Templates');
  if (tt && tt.getLastRow() > 1) {
    tt.getRange(2, 1, tt.getLastRow() - 1, 4).getValues().forEach(r => {
      const k = String(r[0]).trim();
      applyCustomValue_('EMAIL:' + k + ':subject', r[2]);
      applyCustomValue_('EMAIL:' + k + ':body', r[3]);
    });
  }
}

/**
 * Creates the "Customization" tab, or adds any rows missing from it. Existing values are kept.
 * Values from the older Settings / Email Templates tabs are carried over, and those tabs removed.
 */
function ensureCustomizationTab_(ss) {
  let sh = ss.getSheetByName(SHEETS.CUSTOMIZATION);
  const isNew = !sh;
  if (isNew) {
    loadLegacyTabs_(ss); // start from the old tabs' values, if any
    sh = ss.insertSheet(SHEETS.CUSTOMIZATION, 0);
  }

  const existing = {};
  if (!isNew && sh.getLastRow() > 0) {
    sh.getRange(1, 1, sh.getLastRow(), 1).getValues().forEach(r => { existing[String(r[0]).trim()] = true; });
  }

  const rows = [];   // [key, label, value, note]
  const kinds = [];  // 'title' | 'header' | 'bool' | 'text' | 'number' | 'body'
  if (isNew) {
    rows.push(['Key (don\'t edit)', 'Item', 'Value — edit this column', 'Notes']);
    kinds.push('title');
  }
  CUSTOMIZATION_LAYOUT.forEach(section => {
    const items = [];
    section[1].forEach(item => {
      const key = item[0];
      const m = /^EMAIL:(\w+)$/.exec(key);
      if (m) {
        const t = TEMPLATES[m[1]];
        if (!t) return;
        if (!existing[key + ':subject']) items.push([[key + ':subject', item[1] + ' — subject', t.subject, item[2]], 'text']);
        if (!existing[key + ':body']) items.push([[key + ':body', item[1] + ' — body', t.body, ''], 'body']);
      } else if (!existing[key] && key in CONFIG) {
        const v = CONFIG[key];
        items.push([[key, item[1], v, item[2]], typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : 'text']);
      }
    });
    if (!items.length) return;
    if (!existing['§ ' + section[0]]) {
      rows.push(['§ ' + section[0], section[0], '', section[0] === 'EMAIL WORDING' ? PLACEHOLDER_HELP : '']);
      kinds.push('header');
    }
    items.forEach(it => { rows.push(it[0]); kinds.push(it[1]); });
  });
  if (!rows.length) return;

  const start = sh.getLastRow() + 1;
  const range = sh.getRange(start, 1, rows.length, 4);
  range.setNumberFormat('@'); // keep text as text
  range.setValues(rows.map(r => r.map(v => (typeof v === 'boolean' ? v : String(v)))));

  kinds.forEach((k, i) => {
    const row = start + i;
    const line = sh.getRange(row, 1, 1, 4);
    if (k === 'title') {
      line.setFontWeight('bold').setBackground('#e8eaed');
    } else if (k === 'header') {
      line.setFontWeight('bold').setBackground('#f1f3f4');
      sh.getRange(row, 4).setFontWeight('normal').setFontColor('#5f6368');
    } else if (k === 'bool') {
      sh.getRange(row, 3).setNumberFormat('General').insertCheckboxes().setValue(rows[i][2] === true);
    } else if (k === 'number') {
      sh.getRange(row, 3).setNumberFormat('0').setValue(Number(rows[i][2])).setHorizontalAlignment('left');
    }
  });

  if (isNew) {
    sh.setFrozenRows(1);
    sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 280); sh.setColumnWidth(3, 520); sh.setColumnWidth(4, 360);
    sh.hideColumns(1);
    sh.getRange('A:D').setVerticalAlignment('top').setWrap(true);
    sh.getRange('B:B').setFontWeight('bold');
    sh.getRange('D:D').setFontColor('#5f6368');
    sh.getRange('1:1').setFontWeight('bold');

    ['Settings', 'Email Templates'].forEach(n => { const old = ss.getSheetByName(n); if (old) ss.deleteSheet(old); });
  }
}

// ───────────────────────────── Sheet layout ─────────────────────────────
const SHEETS = { CUSTOMIZATION: 'Customization', ASSOCIATES: 'Associates', BOOKINGS: 'Bookings' };
const BOOKING_HEADERS = [
  'Booking ID', 'Created', 'Status', 'Start (UTC)', 'End (UTC)',
  'Participant Name', 'Participant Email', 'Participant Time Zone', 'Recording Consent',
  'Associate Name', 'Associate Email',
  'Zoom Meeting ID', 'Zoom Join URL', 'Zoom Passcode', 'Calendar Event ID',
  'Participant Reminder (Day)', 'Participant Reminder (Hour)', 'Associate Reminder (Day)',
  'Host Link Sent', 'Outcome', 'Follow-up Sent',
];
const STATUS = { BOOKED: 'Booked', CANCEL: 'Cancel', CANCELLED: 'Cancelled' };
const OUTCOME = { COMPLETED: 'Completed', NO_SHOW: 'No-show', NOT_HELD: 'Not held', UNKNOWN: 'Unknown' };

// ───────────────────────────── Setup & testing ─────────────────────────────

/** Run once from the editor. Creates the sheet tabs and the 5-minute background trigger. Safe to re-run. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Open this project from your Google Sheet (Extensions > Apps Script) and run setup again.');
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());

  if (!ss.getSheetByName(SHEETS.ASSOCIATES)) {
    const a = ss.insertSheet(SHEETS.ASSOCIATES);
    a.appendRow(['Name', 'Email', 'Time Zone', 'Active']);
    a.appendRow(['Example Associate', 'associate@yourcompany.com', 'America/New_York', true]);
    a.getRange('D2:D').insertCheckboxes();
    a.setFrozenRows(1);
  }

  let b = ss.getSheetByName(SHEETS.BOOKINGS);
  if (!b) {
    b = ss.insertSheet(SHEETS.BOOKINGS);
    b.appendRow(BOOKING_HEADERS);
    b.setFrozenRows(1);
  } else {
    // Add any columns introduced by newer versions of this script.
    const head = b.getRange(1, 1, 1, Math.max(1, b.getLastColumn())).getValues()[0];
    BOOKING_HEADERS.filter(h => head.indexOf(h) === -1)
      .forEach(h => b.getRange(1, b.getLastColumn() + 1).setValue(h));
  }

  applyDropdowns_(b);
  ensureCustomizationTab_(ss);

  const sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && ss.getSheets().length > 2 && sheet1.getLastRow() === 0) ss.deleteSheet(sheet1);

  ScriptApp.getProjectTriggers()
    .filter(t => ['runBackgroundJobs', 'onBookingsEdit'].indexOf(t.getHandlerFunction()) !== -1)
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runBackgroundJobs').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('onBookingsEdit').forSpreadsheet(ss).onEdit().create();

  Logger.log('Setup complete. Fill in the Associates tab, then run testConnections.');
}

/** Dropdowns for Status and Outcome in the Bookings tab. */
function applyDropdowns_(sh) {
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const rows = Math.max(sh.getMaxRows(), 2000) - 1;
  if (sh.getMaxRows() < rows + 1) sh.insertRowsAfter(sh.getMaxRows(), rows + 1 - sh.getMaxRows());

  const statusCol = head.indexOf('Status') + 1;
  if (statusCol) {
    sh.getRange(2, statusCol, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([STATUS.BOOKED, STATUS.CANCEL, STATUS.CANCELLED], true)
      .setAllowInvalid(false)
      .setHelpText('Choose "Cancel" to cancel this session. The system changes it to "Cancelled" once the invite and Zoom meeting are withdrawn.')
      .build());
  }
  const outcomeCol = head.indexOf('Outcome') + 1;
  if (outcomeCol) {
    sh.getRange(2, outcomeCol, rows, 1).setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInList([OUTCOME.COMPLETED, OUTCOME.NO_SHOW, OUTCOME.NOT_HELD, OUTCOME.UNKNOWN], true)
      .setAllowInvalid(false)
      .setHelpText('Filled in automatically after the session. Set it yourself to override before the check runs.')
      .build());
  }
}

/** Installable edit trigger: cancels right away when Status is set to "Cancel" (no 5-minute wait). */
function onBookingsEdit(e) {
  try {
    const sh = e && e.range && e.range.getSheet();
    if (!sh || sh.getName() !== SHEETS.BOOKINGS) return;
    loadSettings_();
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const statusCol = head.indexOf('Status') + 1;
    if (e.range.getColumn() > statusCol || e.range.getLastColumn() < statusCol) return;

    const lock = LockService.getScriptLock();
    if (!lock.tryLock(20000)) return; // the 5-minute job will pick it up
    try { processCancellations_(); } finally { lock.releaseLock(); }
  } catch (err) {
    console.error('onBookingsEdit failed: ' + err);
  }
}

/** Run from the editor to process cancellations immediately. */
function processCancellationsNow() {
  loadSettings_();
  processCancellations_();
  Logger.log('Cancellations processed. Check the Status column (and any cell notes) in Bookings.');
}

/** Run from the editor to check Zoom credentials, calendar access, and available slots. */
function testConnections() {
  loadSettings_();
  try {
    zoomToken_();
    Logger.log('Zoom: credentials OK');
  } catch (e) {
    Logger.log('Zoom: NOT CONNECTED — ' + e.message + ' (Calendar checks continue below.)');
  }

  const associates = getAssociates_();
  Logger.log('Associates found: ' + associates.map(a => a.name + ' <' + a.email + '>').join(', '));

  const now = new Date();
  const later = new Date(now.getTime() + CONFIG.BOOKING_WINDOW_DAYS * 86400000);
  associates.forEach(a => {
    const data = getCalendarData_(a.email, now, later);
    if (!data) {
      Logger.log(a.email + ': CANNOT READ CALENDAR (needs "See event details" sharing)');
    } else {
      Logger.log(a.email + ': ' + data.windows.length + ' "' + CONFIG.AVAILABILITY_KEYWORD +
        '" window(s), ' + data.busy.length + ' busy event(s) in the next ' + CONFIG.BOOKING_WINDOW_DAYS + ' days' +
        (data.windows.length ? '' : '  <-- no windows found; check event titles and sharing'));
    }
  });

  const slots = getAvailableSlots();
  Logger.log('Bookable slots in the next ' + CONFIG.BOOKING_WINDOW_DAYS + ' days: ' + slots.length);
  if (slots.length) Logger.log('First slot (UTC): ' + slots[0]);
  Logger.log('Booking link used in emails: ' + (bookingUrl_() || '(not set — set BOOKING_URL after deploying)'));
}

/** Run from the editor to check calendar access and open times only (no Zoom needed). */
function testCalendars() {
  loadSettings_();
  const tz = Session.getScriptTimeZone();
  const fmt = d => Utilities.formatDate(d, tz, 'EEE MMM d, h:mm a');
  const associates = getAssociates_();
  if (!associates.length) { Logger.log('No active associates found in the Associates tab.'); return; }

  const now = new Date();
  const later = new Date(now.getTime() + CONFIG.BOOKING_WINDOW_DAYS * 86400000);
  Logger.log('Checking the next ' + CONFIG.BOOKING_WINDOW_DAYS + ' days (times shown in ' + tz + ')');

  associates.forEach(a => {
    const data = getCalendarData_(a.email, now, later);
    if (!data) {
      Logger.log('✗ ' + a.name + ' <' + a.email + '>: CANNOT READ CALENDAR. They need to share it with ' +
        Session.getEffectiveUser().getEmail() + ' at "See event details".');
      return;
    }
    Logger.log('✓ ' + a.name + ' <' + a.email + '>: calendar readable. ' +
      data.windows.length + ' availability window(s), ' + data.busy.length + ' other busy event(s).');
    data.windows.forEach(w => Logger.log('    window: ' + fmt(w.start) + ' – ' + fmt(w.end)));
    if (!data.windows.length) {
      Logger.log('    No events titled "' + CONFIG.AVAILABILITY_KEYWORD + '" found. Check the title, the dates, ' +
        'and that sharing is "See event details" (not free/busy).');
    }
  });

  const slots = getAvailableSlots();
  Logger.log('Bookable slots (after the ' + CONFIG.MIN_NOTICE_HOURS + '-hour minimum notice): ' + slots.length);
  slots.slice(0, 15).forEach(s => Logger.log('    ' + fmt(new Date(s))));
  if (slots.length > 15) Logger.log('    …and ' + (slots.length - 15) + ' more');
}

/** Run from the editor to email yourself a sample of every template. */
function previewEmails() {
  loadSettings_();
  const me = Session.getEffectiveUser().getEmail();
  const start = new Date(Date.now() + 86400000);
  const sample = {
    participantName: 'Jamie Rivera', associateName: 'Jordan Lee',
    start: start, joinUrl: 'https://zoom.us/j/1234567890?pwd=example', passcode: '123456',
    hostLink: 'https://zoom.us/s/1234567890?zak=example',
  };
  const tz = Session.getScriptTimeZone();
  Object.keys(TEMPLATES).forEach(key => {
    sendTemplate_(me, TEMPLATES[key], bookingVars_(sample, tz), '[PREVIEW ' + key + '] ');
  });
  Logger.log('Sent ' + Object.keys(TEMPLATES).length + ' preview emails to ' + me);
}

// ───────────────────────────── Web app (participant-facing) ─────────────────────────────

function doGet() {
  loadSettings_();
  const t = HtmlService.createTemplateFromFile('Booking');
  t.cfg = {
    company: CONFIG.COMPANY_NAME,
    title: CONFIG.SESSION_TITLE,
    intro: CONFIG.PAGE_INTRO,
    minutes: CONFIG.INTERVIEW_MINUTES,
    requireConsent: CONFIG.REQUIRE_RECORDING_CONSENT,
    consentText: CONFIG.CONSENT_TEXT,
    buttonLabel: CONFIG.BUTTON_LABEL,
    confirmTitle: CONFIG.CONFIRM_TITLE,
    confirmText: CONFIG.CONFIRM_TEXT,
  };
  return t.evaluate()
    .setTitle(CONFIG.COMPANY_NAME + ' – Schedule your ' + CONFIG.SESSION_TITLE.toLowerCase())
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Returns bookable slot start times as sorted UTC ISO strings. Called by the booking page. */
function getAvailableSlots() {
  loadSettings_();
  const now = Date.now();
  const start = new Date(now + CONFIG.MIN_NOTICE_HOURS * 3600000);
  const end = new Date(now + CONFIG.BOOKING_WINDOW_DAYS * 86400000);
  return Object.keys(computeSlots_(start, end)).sort();
}

/** Books a slot. Called by the booking page. Throws a readable error on failure. */
function bookSlot(slotIso, name, email, timeZone, consent) {
  loadSettings_();
  name = String(name || '').trim();
  email = String(email || '').trim().toLowerCase();
  if (!name || name.length > 100) throw new Error('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email address.');
  if (CONFIG.REQUIRE_RECORDING_CONSENT && consent !== true) {
    throw new Error('Please check the recording consent box to continue.');
  }
  const tz = validTimeZone_(timeZone);
  const start = new Date(slotIso);
  if (isNaN(start.getTime())) throw new Error('That time is not valid. Please pick another.');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('The scheduler is busy right now. Please try again in a moment.');
  try {
    if (start.getTime() < Date.now() + CONFIG.MIN_NOTICE_HOURS * 3600000) {
      throw new Error('That time is too soon to book. Please pick a later time.');
    }
    const existing = getBookings_().filter(b => b.status === STATUS.BOOKED &&
      b.participantEmail === email && b.end.getTime() > Date.now());
    if (existing.length) {
      throw new Error('You already have a session booked. Check your email for the invite.');
    }

    const end = new Date(start.getTime() + CONFIG.INTERVIEW_MINUTES * 60000);
    const free = computeSlots_(start, end)[start.toISOString()];
    if (!free || !free.length) throw new Error('Sorry, that time was just taken. Please pick another.');

    const associate = pickAssociate_(free);
    const meeting = createZoomMeeting_(start, associate, name);
    let eventId;
    try {
      eventId = createCalendarEvent_(start, end, associate, name, email, meeting);
    } catch (e) {
      try { zoomApi_('delete', '/meetings/' + meeting.id); } catch (ignored) {}
      throw e;
    }

    const row = {
      'Booking ID': Utilities.getUuid().slice(0, 8),
      'Created': new Date(),
      'Status': STATUS.BOOKED,
      'Start (UTC)': start.toISOString(),
      'End (UTC)': end.toISOString(),
      'Participant Name': name,
      'Participant Email': email,
      'Participant Time Zone': tz,
      'Recording Consent': CONFIG.REQUIRE_RECORDING_CONSENT ? new Date() : '',
      'Associate Name': associate.name,
      'Associate Email': associate.email,
      'Zoom Meeting ID': "'" + meeting.id,
      'Zoom Join URL': meeting.join_url,
      'Zoom Passcode': meeting.password ? "'" + meeting.password : '',
      'Calendar Event ID': eventId,
    };
    const sh = sheet_(SHEETS.BOOKINGS);
    const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    sh.appendRow(head.map(h => (h in row ? row[h] : '')));
    SpreadsheetApp.flush();

    if (CONFIG.SEND_ASSOCIATE_CONFIRMATIONS) {
      try {
        sendTemplate_(associate.email, TEMPLATES.ASSOCIATE_BOOKED, bookingVars_({
          participantName: name, associateName: associate.name, start: start,
          joinUrl: meeting.join_url, passcode: meeting.password,
        }, associate.tz), '', true);
      } catch (e) {
        console.error('Associate confirmation email failed: ' + e);
      }
    }

    return { start: start.toISOString(), minutes: CONFIG.INTERVIEW_MINUTES };
  } finally {
    lock.releaseLock();
  }
}

// ───────────────────────────── Availability ─────────────────────────────

/** Returns { slotStartIso: [emails of associates free then] } for slots fully inside [rangeStart, rangeEnd]. */
function computeSlots_(rangeStart, rangeEnd) {
  const dur = CONFIG.INTERVIEW_MINUTES * 60000;
  const buf = CONFIG.BUFFER_MINUTES * 60000;
  const associates = getAssociates_();
  if (!associates.length) return {};

  const bookings = getBookings_().filter(b => b.status === STATUS.BOOKED);
  const overlaps = (s, e, x) => s < x.end.getTime() + buf && e > x.start.getTime() - buf;
  const slots = {};

  associates.forEach(a => {
    const data = getCalendarData_(a.email,
      new Date(rangeStart.getTime() - dur - buf), new Date(rangeEnd.getTime() + buf));
    if (!data) return; // calendar unreadable: treat as unavailable
    const aBusy = data.busy.concat(bookings.filter(b => b.associateEmail === a.email));
    slotsInWindows_(data.windows, rangeStart, rangeEnd).forEach(s => {
      const st = s.getTime();
      if (!aBusy.some(x => overlaps(st, st + dur, x))) {
        const k = s.toISOString();
        (slots[k] = slots[k] || []).push(a.email);
      }
    });
  });

  // Respect the Zoom account's concurrent-meeting limit.
  Object.keys(slots).forEach(k => {
    const st = new Date(k).getTime();
    const running = bookings.filter(b => overlaps(st, st + dur, b)).length;
    if (running >= CONFIG.MAX_CONCURRENT) delete slots[k];
  });
  return slots;
}

/** Slot start times inside the given availability windows, stepping from each window's start. */
function slotsInWindows_(windows, rangeStart, rangeEnd) {
  const step = CONFIG.SLOT_STEP_MINUTES * 60000;
  const dur = CONFIG.INTERVIEW_MINUTES * 60000;
  const seen = {};
  const out = [];
  windows.forEach(w => {
    for (let t = w.start.getTime(); t + dur <= w.end.getTime(); t += step) {
      if (t >= rangeStart.getTime() && t + dur <= rangeEnd.getTime() && !seen[t]) {
        seen[t] = true;
        out.push(new Date(t));
      }
    }
  });
  return out;
}

/**
 * Reads an associate's calendar between timeMin and timeMax.
 * Returns { windows: [...], busy: [...] } of {start, end}, or null if the calendar can't be read.
 *  - windows: timed events whose title contains CONFIG.AVAILABILITY_KEYWORD
 *  - busy:    every other event that blocks time (not marked "Free", not declined, not cancelled)
 * Requires "See event details" access, since titles are needed to find the windows.
 */
function getCalendarData_(email, timeMin, timeMax) {
  const keyword = CONFIG.AVAILABILITY_KEYWORD.toLowerCase();
  const windows = [];
  const busy = [];
  let pageToken;
  try {
    do {
      const res = Calendar.Events.list(email, {
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,   // expands recurring windows into individual occurrences
        orderBy: 'startTime',
        maxResults: 250,
        pageToken: pageToken,
      });
      const calTz = res.timeZone || Session.getScriptTimeZone();
      (res.items || []).forEach(ev => {
        if (ev.status === 'cancelled' || !ev.start || !ev.end) return;
        const declined = (ev.attendees || []).some(x => x.self && x.responseStatus === 'declined');
        if (declined) return;

        const allDay = !ev.start.dateTime;
        const start = allDay ? Utilities.parseDate(ev.start.date, calTz, 'yyyy-MM-dd') : new Date(ev.start.dateTime);
        const end = allDay ? Utilities.parseDate(ev.end.date, calTz, 'yyyy-MM-dd') : new Date(ev.end.dateTime);
        const title = String(ev.summary || '').toLowerCase();

        if (title.indexOf(keyword) !== -1) {
          if (!allDay) windows.push({ start: start, end: end });
        } else if (ev.transparency !== 'transparent') {
          busy.push({ start: start, end: end });
        }
      });
      pageToken = res.nextPageToken;
    } while (pageToken);
  } catch (e) {
    console.warn('Cannot read calendar for ' + email + ': ' + e);
    return null;
  }
  return { windows: windows, busy: busy };
}

/** Fewest bookings first; ties go to whoever was booked least recently, then random. */
function pickAssociate_(freeEmails) {
  const all = getBookings_().filter(b => b.status === STATUS.BOOKED);
  const candidates = getAssociates_().filter(a => freeEmails.indexOf(a.email) !== -1).map(a => {
    const mine = all.filter(b => b.associateEmail === a.email);
    const last = mine.reduce((m, b) => Math.max(m, b.created ? new Date(b.created).getTime() : 0), 0);
    return { a: a, count: mine.length, last: last, rand: Math.random() };
  });
  candidates.sort((x, y) => x.count - y.count || x.last - y.last || x.rand - y.rand);
  return candidates[0].a;
}

// ───────────────────────────── Zoom ─────────────────────────────

function zoomToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('zoom_token');
  if (cached) return cached;

  const p = PropertiesService.getScriptProperties();
  const accountId = p.getProperty('ZOOM_ACCOUNT_ID');
  const clientId = p.getProperty('ZOOM_CLIENT_ID');
  const secret = p.getProperty('ZOOM_CLIENT_SECRET');
  if (!accountId || !clientId || !secret) {
    throw new Error('Zoom credentials missing. Add ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET in Project Settings > Script properties.');
  }
  const res = UrlFetchApp.fetch(
    'https://zoom.us/oauth/token?grant_type=account_credentials&account_id=' + encodeURIComponent(accountId),
    { method: 'post', headers: { Authorization: 'Basic ' + Utilities.base64Encode(clientId + ':' + secret) }, muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('Zoom sign-in failed: ' + res.getContentText());
  const json = JSON.parse(res.getContentText());
  cache.put('zoom_token', json.access_token, Math.max(60, Math.min(3000, (json.expires_in || 3600) - 120)));
  return json.access_token;
}

/** Calls the Zoom API. Throws an error whose .code is the HTTP status on failure. */
function zoomApi_(method, path, body) {
  const opts = {
    method: method,
    headers: { Authorization: 'Bearer ' + zoomToken_() },
    muteHttpExceptions: true,
  };
  if (body) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch('https://api.zoom.us/v2' + path, opts);
  const code = res.getResponseCode();
  if (code >= 300 && !(method === 'delete' && code === 404)) {
    const err = new Error('Zoom ' + method.toUpperCase() + ' ' + path + ' failed (' + code + '): ' + res.getContentText());
    err.code = code;
    throw err;
  }
  const txt = res.getContentText();
  return txt ? JSON.parse(txt) : {};
}

function createZoomMeeting_(start, associate, participantName) {
  return zoomApi_('post', '/users/me/meetings', {
    topic: CONFIG.SESSION_TITLE + ': ' + participantName + ' with ' + associate.name,
    type: 2, // scheduled
    start_time: Utilities.formatDate(start, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"),
    duration: CONFIG.INTERVIEW_MINUTES,
    timezone: 'UTC',
    settings: {
      join_before_host: false, // the associate starts the meeting as host via their host link
      waiting_room: true,      // the participant waits until the associate admits them
      host_video: true,
      participant_video: true,
      approval_type: 2,        // no registration
    },
  });
}

/**
 * Decides whether a past session happened, from Zoom's participant report.
 * Returns an OUTCOME value, or null if it can't tell yet (try again later).
 */
function zoomOutcome_(b) {
  let res;
  try {
    res = zoomApi_('get', '/past_meetings/' + encodeURIComponent(b.zoomId) + '/participants?page_size=300');
  } catch (e) {
    // 404 / 400 usually means the meeting was never started. Wait a couple of hours in case it ran long.
    if ((e.code === 404 || e.code === 400) && Date.now() > b.end.getTime() + 2 * 3600000) return OUTCOME.NOT_HELD;
    console.warn('Attendance check not ready for booking ' + b.id + ': ' + e);
    return null;
  }
  const people = {};
  (res.participants || []).forEach(p => {
    const key = String(p.user_email || p.name || p.id || '').trim().toLowerCase();
    if (key) people[key] = true;
  });
  // The associate (host) is one person; anyone else means the participant joined.
  return Object.keys(people).length >= 2 ? OUTCOME.COMPLETED : OUTCOME.NO_SHOW;
}

// ───────────────────────────── Calendar invite ─────────────────────────────

function createCalendarEvent_(start, end, associate, participantName, participantEmail, meeting) {
  const lines = [
    'Your ' + CONFIG.SESSION_TITLE.toLowerCase() + ' with ' + CONFIG.COMPANY_NAME + ' is confirmed.',
    '',
    CONFIG.INVITE_HOST_LABEL + ': ' + associate.name,
    'Participant: ' + participantName,
    '',
    'Join Zoom: ' + meeting.join_url,
    'Meeting ID: ' + meeting.id + (meeting.password ? '   Passcode: ' + meeting.password : ''),
    '',
  ];
  if (CONFIG.REQUIRE_RECORDING_CONSENT) lines.push('This session will be recorded and transcribed.', '');
  lines.push('If you need to reschedule, reply to this invite.');

  const body = {
    summary: CONFIG.COMPANY_NAME + ' ' + CONFIG.SESSION_TITLE + ': ' + participantName + ' / ' + associate.name,
    description: lines.join('\n'),
    location: meeting.join_url,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    guestsCanInviteOthers: false,
    reminders: { useDefault: true },
  };

  // Step 1: create the event with no guests, so nothing is sent yet. Google may auto-attach a
  // Google Meet link here if the scheduler account's "Automatically add Google Meet" setting is on.
  const created = Calendar.Events.insert(body, 'primary', { sendUpdates: 'none' });

  // Step 2: replace the event with the guests added. With conferenceDataVersion 1 and no
  // conferenceData in the body, any auto-attached Meet link is removed before invites go out.
  body.attendees = [{ email: participantEmail }, { email: associate.email }];
  const final = Calendar.Events.update(body, 'primary', created.id, { sendUpdates: 'all', conferenceDataVersion: 1 });
  if (final.hangoutLink || final.conferenceData) {
    console.warn('Google Meet is still attached to event ' + created.id + '. Turn off "Automatically add Google Meet" ' +
      'in the scheduler account\'s Google Calendar settings.');
  }
  return created.id;
}

// ───────────────────────────── Background jobs (every 5 minutes) ─────────────────────────────

function runBackgroundJobs() {
  loadSettings_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    [processCancellations_, sendReminders_, sendHostLinks_, processFollowUps_].forEach(job => {
      try { job(); } catch (e) { console.error(job.name + ' failed: ' + e); }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Day-before and hour-before reminders. */
function sendReminders_() {
  const now = Date.now();
  const assocTz = associateTimeZones_();
  getBookings_().forEach(b => {
    if (b.status !== STATUS.BOOKED) return;
    const untilStart = b.start.getTime() - now;
    if (untilStart <= 0) return;
    const bookedAhead = b.start.getTime() - (b.created ? new Date(b.created).getTime() : 0);
    const dayReminderUseful = bookedAhead >= 30 * 3600000; // skip if booked less than ~a day ahead

    if (untilStart <= 24 * 3600000) {
      if (CONFIG.SEND_PARTICIPANT_DAY_BEFORE && !b.sent.participantDay) {
        sendOnce_(b, 'Participant Reminder (Day)', dayReminderUseful, () =>
          sendTemplate_(b.participantEmail, TEMPLATES.PARTICIPANT_DAY_BEFORE, bookingVars_(b, b.participantTz)));
      }
      if (CONFIG.SEND_ASSOCIATE_DAY_BEFORE && !b.sent.associateDay) {
        sendOnce_(b, 'Associate Reminder (Day)', dayReminderUseful, () =>
          sendTemplate_(b.associateEmail, TEMPLATES.ASSOCIATE_DAY_BEFORE,
            bookingVars_(b, assocTz[b.associateEmail] || Session.getScriptTimeZone()), '', true));
      }
    }
    if (untilStart <= 60 * 60000 && CONFIG.SEND_PARTICIPANT_HOUR_BEFORE && !b.sent.participantHour) {
      sendOnce_(b, 'Participant Reminder (Hour)', true, () =>
        sendTemplate_(b.participantEmail, TEMPLATES.PARTICIPANT_HOUR_BEFORE, bookingVars_(b, b.participantTz)));
    }
  });
}

/** Emails each associate a fresh Zoom host link shortly before their session. */
function sendHostLinks_() {
  const now = Date.now();
  const lead = CONFIG.HOST_LINK_LEAD_MINUTES * 60000;
  const assocTz = associateTimeZones_();

  getBookings_().forEach(b => {
    if (b.status !== STATUS.BOOKED || b.sent.hostLink) return;
    if (b.start.getTime() - now > lead || b.end.getTime() <= now) return;
    sendOnce_(b, 'Host Link Sent', true, () => {
      const m = zoomApi_('get', '/meetings/' + encodeURIComponent(b.zoomId));
      const vars = bookingVars_(b, assocTz[b.associateEmail] || Session.getScriptTimeZone());
      vars.host_link = m.start_url;
      let tpl = TEMPLATES.HOST_LINK;
      if (tpl.body.indexOf('{{host_link}}') === -1) {
        tpl = Object.assign({}, tpl, { body: tpl.body + '\n\n{{host_link}}' }); // never send without the link
      }
      sendTemplate_(b.associateEmail, tpl, vars, '', true);
    });
  });
}

/** After each session: record attendance from Zoom, then send a thank-you or a rebooking email. */
function processFollowUps_() {
  const now = Date.now();
  getBookings_().forEach(b => {
    if (b.status !== STATUS.BOOKED || b.sent.followUp) return;
    if (now < b.end.getTime() + CONFIG.FOLLOW_UP_AFTER_MINUTES * 60000) return;

    let outcome = b.outcome; // an admin can fill this in by hand; it's respected
    if (!outcome) {
      outcome = zoomOutcome_(b);
      if (!outcome) {
        if (now > b.end.getTime() + 24 * 3600000) {
          setCell_(b.row, 'Outcome', OUTCOME.UNKNOWN);
          setCell_(b.row, 'Follow-up Sent', 'Skipped (attendance unknown)');
        }
        return;
      }
      setCell_(b.row, 'Outcome', outcome);
    }

    let tpl = null;
    if (/complet/i.test(outcome)) tpl = TEMPLATES.PARTICIPANT_THANK_YOU;
    else if (/no.?show/i.test(outcome)) tpl = TEMPLATES.PARTICIPANT_MISSED;

    if (!CONFIG.SEND_FOLLOW_UP || !tpl) {
      setCell_(b.row, 'Follow-up Sent', 'Skipped (' + outcome + ')');
      return;
    }
    sendOnce_(b, 'Follow-up Sent', true, () =>
      sendTemplate_(b.participantEmail, tpl, bookingVars_(b, b.participantTz)));
  });
}

/** Booking rows whose Status was set to "Cancel": delete the Zoom meeting and the invite. */
function processCancellations_() {
  getBookings_().forEach(b => {
    if (String(b.status).toLowerCase() !== STATUS.CANCEL.toLowerCase()) return;
    const statusCell = cell_(b.row, 'Status');
    try {
      if (b.zoomId) zoomApi_('delete', '/meetings/' + encodeURIComponent(b.zoomId));
      if (b.eventId) {
        const id = String(b.eventId).replace(/@google\.com$/, '');
        try {
          Calendar.Events.remove('primary', id, { sendUpdates: 'all' });
        } catch (e) {
          if (!/not found|deleted|410|404/i.test(String(e))) throw e; // already gone is fine
        }
      }
      statusCell.setValue(STATUS.CANCELLED).setNote('');
      if (CONFIG.SEND_ASSOCIATE_CONFIRMATIONS && b.associateEmail) {
        try {
          sendTemplate_(b.associateEmail, TEMPLATES.ASSOCIATE_CANCELLED,
            bookingVars_(b, associateTimeZones_()[b.associateEmail] || Session.getScriptTimeZone()), '', true);
        } catch (e) {
          console.error('Associate cancellation email failed for booking ' + b.id + ': ' + e);
        }
      }
    } catch (e) {
      console.error('Cancellation failed for booking ' + b.id + ': ' + e);
      statusCell.setNote('Cancellation failed (' + new Date().toLocaleString() + '): ' + String(e).slice(0, 400) +
        '\nIt will retry automatically every 5 minutes.');
    }
  });
}

/** Runs send() and stamps the column; if shouldSend is false, marks the column as skipped instead. */
function sendOnce_(b, column, shouldSend, send) {
  if (!shouldSend) { setCell_(b.row, column, 'Skipped (booked late)'); return; }
  try {
    send();
    setCell_(b.row, column, new Date());
  } catch (e) {
    console.error(column + ' failed for booking ' + b.id + ': ' + e);
  }
}

// ───────────────────────────── Email helpers ─────────────────────────────

function bookingVars_(b, tz) {
  tz = tz || Session.getScriptTimeZone();
  return {
    company: CONFIG.COMPANY_NAME,
    service: CONFIG.SERVICE_NAME,
    session: CONFIG.SESSION_TITLE.toLowerCase(),
    participant_name: b.participantName,
    participant_first_name: firstName_(b.participantName),
    associate_name: b.associateName,
    associate_first_name: firstName_(b.associateName),
    date_time: Utilities.formatDate(b.start, tz, "EEEE, MMMM d 'at' h:mm a z"),
    time: Utilities.formatDate(b.start, tz, 'h:mm a z'),
    duration: CONFIG.INTERVIEW_MINUTES,
    zoom_link: b.joinUrl,
    passcode: b.passcode || '(included in the link)',
    booking_link: bookingUrl_() || '(reply to this email and we\'ll send a new time)',
    admin_name: CONFIG.ADMIN_NAME,
    host_link: b.hostLink || '',
  };
}

function renderTemplate_(tpl, vars) {
  const HOST_MARK = '@@HOST_LINK@@';
  const fill = (s, forHtml) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => {
    if (k === 'host_link' && forHtml && vars.host_link) return HOST_MARK;
    return k in vars ? String(vars[k]) : m;
  });
  const text = fill(tpl.body, false);
  const html = escapeHtml_(fill(tpl.body, true))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')
    .replace(HOST_MARK, '<a href="' + escapeHtml_(vars.host_link || '') +
      '" style="font-size:16px;font-weight:bold">Start the meeting as host</a>');
  return {
    subject: fill(tpl.subject).replace(/\*\*/g, ''),
    plain: text.replace(/\*\*/g, ''),
    html: '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">' + html + '</div>',
  };
}

function sendTemplate_(to, tpl, vars, subjectPrefix, internal) {
  const r = renderTemplate_(tpl, vars);
  const msg = {
    to: to,
    subject: (subjectPrefix || '') + r.subject,
    body: r.plain,
    htmlBody: r.html,
    name: CONFIG.COMPANY_NAME,
  };
  if (CONFIG.REPLY_TO && !internal) msg.replyTo = CONFIG.REPLY_TO;
  MailApp.sendEmail(msg);
}

function bookingUrl_() {
  const fromProps = PropertiesService.getScriptProperties().getProperty('BOOKING_URL');
  if (fromProps) return fromProps;
  if (CONFIG.BOOKING_URL) return CONFIG.BOOKING_URL;
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

function firstName_(s) { return String(s || '').trim().split(/\s+/)[0] || 'there'; }

function validTimeZone_(tz) {
  tz = String(tz || '').trim();
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return Session.getScriptTimeZone();
  try { Utilities.formatDate(new Date(), tz, 'z'); return tz; } catch (e) { return Session.getScriptTimeZone(); }
}

// ───────────────────────────── Sheet helpers ─────────────────────────────

function spreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('Missing "' + name + '" tab. Run setup first.');
  return sh;
}

function cell_(row, header) {
  const sh = sheet_(SHEETS.BOOKINGS);
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const col = head.indexOf(header) + 1;
  if (!col) throw new Error('Missing column "' + header + '" in Bookings. Run setup again.');
  return sh.getRange(row, col);
}

function setCell_(row, header, value) {
  cell_(row, header).setValue(value);
}

function getAssociates_() {
  const values = sheet_(SHEETS.ASSOCIATES).getDataRange().getDisplayValues();
  const head = values.shift().map(h => h.trim());
  const c = n => head.indexOf(n);
  return values
    .filter(r => r[c('Email')] && String(r[c('Active')]).toUpperCase() !== 'FALSE')
    .map(r => ({
      name: r[c('Name')].trim(),
      email: r[c('Email')].trim().toLowerCase(),
      tz: (c('Time Zone') !== -1 && r[c('Time Zone')].trim()) || Session.getScriptTimeZone(),
    }));
}

function associateTimeZones_() {
  const out = {};
  getAssociates_().forEach(a => { out[a.email] = a.tz; });
  return out;
}

function getBookings_() {
  const values = sheet_(SHEETS.BOOKINGS).getDataRange().getValues();
  const head = values.shift();
  const v = (r, n) => { const i = head.indexOf(n); return i === -1 ? '' : r[i]; };
  return values.map((r, i) => ({
    row: i + 2,
    id: v(r, 'Booking ID'),
    created: v(r, 'Created'),
    status: String(v(r, 'Status')).trim(),
    start: new Date(v(r, 'Start (UTC)')),
    end: new Date(v(r, 'End (UTC)')),
    participantName: String(v(r, 'Participant Name')),
    participantEmail: String(v(r, 'Participant Email')).toLowerCase(),
    participantTz: String(v(r, 'Participant Time Zone')) || Session.getScriptTimeZone(),
    associateName: String(v(r, 'Associate Name')),
    associateEmail: String(v(r, 'Associate Email')).toLowerCase(),
    zoomId: String(v(r, 'Zoom Meeting ID')).replace(/^'/, ''),
    joinUrl: String(v(r, 'Zoom Join URL')),
    passcode: String(v(r, 'Zoom Passcode')).replace(/^'/, ''),
    eventId: v(r, 'Calendar Event ID'),
    outcome: String(v(r, 'Outcome')).trim(),
    sent: {
      participantDay: v(r, 'Participant Reminder (Day)'),
      participantHour: v(r, 'Participant Reminder (Hour)'),
      associateDay: v(r, 'Associate Reminder (Day)'),
      hostLink: v(r, 'Host Link Sent'),
      followUp: v(r, 'Follow-up Sent'),
    },
  })).filter(b => b.id && !isNaN(b.start.getTime()));
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
