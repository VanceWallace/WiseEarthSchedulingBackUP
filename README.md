# Session Scheduler — Setup Walkthrough

A free booking page (Google Apps Script) that merges 5 associates' availability windows from their Google Calendars, spreads sessions evenly, and creates a Zoom meeting on one shared Zoom account for each booking. It sends reminders, emails each associate a **host link** ~15 minutes before the session, checks Zoom afterward for attendance, and sends a thank-you or rebooking email.

**Files:** `Code.gs` (logic) and `Booking.html` (the participant-facing page).

**Who does what:** Steps marked **(admin)** need the client's Zoom admin or Google Workspace admin. Everything else can be done by whoever is signed in to the scheduler Google account.

Total time: about 45 minutes, plus waiting on associates to share calendars.

---

## Step 1 — Pick the scheduler Google account

Use a Google Workspace account in the client's domain to own everything, ideally a dedicated one like `interviews@clientdomain.com`. Every invite and email comes from this address, and the Sheet lives in its Drive.

Sign in to it in a browser profile of its own (or an incognito window) so it doesn't mix with your personal Google account.

## Step 2 — Create the Sheet and script project

1. Go to **sheets.new** and name the spreadsheet "Session Scheduler".
2. **Extensions → Apps Script.** A new tab opens with the script editor.
3. Rename the project (top left, "Untitled project") to "Session Scheduler".
4. **Code.gs:** select everything in the editor, delete it, and paste in the full contents of `Code.gs`. Press **Ctrl/Cmd + S**.
5. **Booking page:** in the left sidebar, click **+** next to *Files* → **HTML**, name it `Booking` (exactly, no `.html`), replace its contents with `Booking.html`, and save.
6. **Calendar API:** in the left sidebar, click **+** next to *Services* → choose **Google Calendar API** → **Add**. Leave the identifier as `Calendar`.
7. Save. Names, wording, booking rules, and email text are edited later in the Sheet's **Customization** tab, which `setup` creates in Step 5. You don't need to touch the code for them.

## Step 3 — Create the Zoom API app (admin)

The Zoom account owner or an admin does this at **marketplace.zoom.us**.

1. **Develop → Build App → Server-to-Server OAuth App.** Name it "Session Scheduler".
2. On **App Credentials**, copy the **Account ID**, **Client ID**, and **Client Secret**.
3. **Information:** fill in the required company name and contact email.
4. **Scopes → Add Scopes.** Add the ones that allow:
   - creating meetings (`meeting:write:meeting:admin`)
   - reading meetings (`meeting:read:meeting:admin`)
   - deleting meetings (`meeting:delete:meeting:admin`)
   - listing past meeting participants (`meeting:read:list_past_participants:admin`)

   Zoom's scope names change from time to time. Pick the closest matches under the *Meeting* category.
5. **Activation → Activate your app.**
6. In Zoom's web settings (**Settings → Meeting**), confirm:
   - **Waiting Room** is allowed
   - **Cloud recording** and **audio transcript** are on, if the client wants recordings
   - the account allows 2 concurrent meetings (if it's a different number, change "Max sessions at the same time" in the Customization tab)

## Step 4 — Add the Zoom credentials to the script

Back in the Apps Script editor:

1. Click the **gear (Project Settings)** in the left sidebar.
2. Scroll to **Script properties → Add script property**, and add these three:
   - `ZOOM_ACCOUNT_ID`
   - `ZOOM_CLIENT_ID`
   - `ZOOM_CLIENT_SECRET`
3. **Save script properties.**

These stay out of the code, so you can share or copy `Code.gs` without leaking them.

## Step 5 — Run setup

1. Go back to the editor (the **< >** icon in the sidebar) with `Code.gs` open.
2. In the toolbar, the dropdown next to **Run** and **Debug** lists the script's functions. Choose **`setup`** and click **Run**.
3. An **Authorization required** prompt appears. Click **Review permissions**, choose the scheduler account, then **Allow**. If you see "Google hasn't verified this app," click **Advanced → Go to Session Scheduler (unsafe)**. That's normal for a script you wrote yourself.
4. The **Execution log** should end with "Setup complete."
5. The Sheet now has three tabs:
   - **Customization**: everything the client may want to change, grouped into sections (names and contacts, booking page text, calendar invite, scheduling rules, which emails are sent and when, and the wording of every email). Edit only the **Value** column. For email wording, keep the `{{placeholders}}` as written; inside a cell, press Ctrl/Cmd + Enter for a new line.
   - **Associates** and **Bookings**.

   Changes in Customization take effect on the next booking or email, with no code edit and no redeploy. A blank or invalid cell falls back to the default. If a row is ever deleted by accident, run `setup` again and it's added back with its default value.

## Step 6 — Add the associates

In the **Associates** tab, replace the example row with one row per associate:

| Column | Example | Notes |
|---|---|---|
| Name | Jordan Lee | Shown in invites and emails |
| Email | jordan@clientdomain.com | Their Google Calendar address |
| Time Zone | America/New_York | Used for times in their emails ([list of names](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)) |
| Active | ☑ | Uncheck to pause someone |

Then send each associate the **Instructions for associates** section below.

## Step 7 — Test the connections

Once at least one associate has shared their calendar and added a window:

1. In the editor, choose **`testConnections`** in the function dropdown and click **Run**.
2. Read the **Execution log**:
   - "Zoom: credentials OK"
   - per associate: number of availability windows and busy events
   - total bookable slots
3. Fixes:
   - **"Zoom sign-in failed"** → the Script properties don't match the Zoom app, or the app isn't activated.
   - **"CANNOT READ CALENDAR"** → that associate hasn't shared their calendar with the scheduler account.
   - **"no windows found"** → no events titled "Interview availability" in the next 14 days, or they shared at free/busy level instead of **See event details**.

## Step 8 — Publish the booking page

1. Top right: **Deploy → New deployment.** Click the gear next to *Select type* → **Web app**.
2. Description: "v1". *Execute as:* **Me**. *Who has access:* **Anyone**.
3. **Deploy**, then copy the **Web app URL** (ends in `/exec`). That's the booking link.
4. Add it as a Script property named `BOOKING_URL` (as in Step 4). The "sorry we missed you" email uses it.
5. Open the link in a private window to check that the page loads without signing in.

If **Anyone** isn't offered, the Workspace admin has blocked public Apps Script web apps. They need to allow sharing outside the domain in the Admin console (Apps → Google Workspace → Drive and Docs → Sharing settings).

**When you change the code later:** Deploy → **Manage deployments** → pencil icon → *Version:* **New version** → Deploy. The URL stays the same.

## Step 9 — Test end to end

1. **Preview emails:** run **`previewEmails`**. The scheduler account receives one sample of every email template. Check the wording.
2. **Test booking:** add yourself as an associate (or use a real one who agrees), add an "Interview availability" window a couple of days out, open the booking link, and book with a personal email address. Check that:
   - both calendar invites arrive, with the Zoom link
   - the Bookings tab has a new row
3. **Test cancellation:** set that row's **Status** to `Cancel`. Within 5 minutes, the invites are withdrawn, the Zoom meeting is deleted, and the status changes to `Cancelled`.
4. Optionally, do a real run-through with a short window to see the host link, reminders, and follow-up arrive. (Temporarily lower "Minimum notice (hours)" in the Customization tab for this, and set it back afterward.)

---

## Instructions for associates

1. **Share your calendar with the scheduler account (one time).** In Google Calendar: *Settings* → your calendar under *Settings for my calendars* → *Share with specific people or groups* → add **wiseplanetsurvey@gmail.com** with the permission **See event details**. (Don't pick the option that also says "make changes"; the scheduler only needs to read your calendar.)
2. **Add windows when you're available.** Create normal calendar events titled **Interview availability**:
   - **Example:** Tuesday 1:00–5:00 pm, titled "Interview availability."
   - **Time-specific, not all-day.** All-day events are ignored as windows.
   - **At least 60 minutes long.** A 1:00–5:00 window offers 1:00, 2:00, 3:00, and 4:00.
   - **Repeats are fine.** Use "Weekly on Tuesday" for regular availability.
   - **More than 24 hours away and within the next 14 days.** Anything sooner is hidden by the minimum-notice setting.
   - **Other events still block time.** Any other event inside the window blocks that time, unless it's marked *Free* or declined.
3. **Booked sessions appear on your calendar automatically.** You'll get a reminder the day before.
4. **About 15 minutes before each session, you'll get a "Host link" email.** Use that link, not the one in the calendar invite. It makes you the host: admit the participant from the waiting room and start the recording. Don't forward it.

---

## How it works day to day

- **Booking:** participants see combined open times in their own time zone, pick one, enter their name and email, and agree to recording. Each participant can hold one upcoming session.
- **Assignment:** among associates free at that time, the one with the fewest bookings gets it. Ties go to whoever was booked least recently.
- **Invite:** participant and associate get a Google Calendar invite with the Zoom link and passcode. The associate also gets a "New session booked" email from the script, and a "Cancelled" email if it's cancelled.
- **Reminders:** the participant gets one the day before and one an hour before, and the associate gets one the day before. Day-before reminders are skipped for sessions booked less than ~30 hours ahead.
- **Host link:** the associate gets a fresh host link about 15 minutes before the start.
- **After the session:** about 30 minutes after the scheduled end, the script asks Zoom who joined and fills in **Outcome**:
  - **Completed** → the participant gets a thank-you.
  - **No-show** → the participant gets a "sorry we missed you" email with the booking link.
  - **Not held** (the meeting never started, e.g. the associate missed it) → no email. Follow up with the participant personally.

  If you type an Outcome yourself before the check runs, yours is used.
- **Capacity:** never more than 2 sessions at the same time.
- **Cancel:** set the row's Status to `Cancel`. Within 5 minutes, both invites are withdrawn and the Zoom meeting is deleted.
- **Reschedule:** cancel, then send the participant the booking link again.
- **Pause an associate:** uncheck Active in the Associates tab.

Every email the system sends is timestamped in its own column of the Bookings tab, so nothing is sent twice and you can see what went out. "Skipped (…)" in a column means that email was intentionally not sent.

## Limitations

- Max 2 simultaneous sessions across the team.
- **Gmail sending limit:** The scheduler account is a regular Gmail account rather than Google Workspace, so it can send about 100 script emails a day. Each session uses up to 6 of them: the associate's booking confirmation, three reminders, the host link, and the follow-up (a cancelled session uses a cancellation email instead). That works out to roughly 16 sessions a day before hitting the cap. Calendar invites and cancellations don't count toward it. For a few weeks of research sessions that should be plenty, but for more volume, turn off one of the reminders in the Customization tab.
- With `BUFFER_MINUTES: 0`, a session that runs long can collide with the next one if two are already running. Set a buffer (e.g., 15) if that becomes a problem.
- Availability is only as good as the associates' calendars: no windows means no bookings.
- The scheduler account can see associates' event titles (needed to find the windows).
- Recordings and transcripts all land in the one shared Zoom account. Download and clear them regularly.
- Host links expire a few hours after sending and grant host control.
- Participants can't reschedule themselves. Changes go through the sheet.
- Built for a short research round. Google's daily quotas are far above what this needs.
