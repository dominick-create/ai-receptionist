require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const twilio = require('twilio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ─── Twilio ───────────────────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// ─── Google Calendar Auth ─────────────────────────────────────────────────────
async function getCalendar() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.join(__dirname, 'google-credentials.json'),
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  const client = await auth.getClient();
  return google.calendar({ version: 'v3', auth: client });
}

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const CLINIC_NAME = process.env.CLINIC_NAME || 'Luxe Medical Spa';
const CLINIC_PHONE = process.env.CLINIC_PHONE || '';
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || '';

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'AI Receptionist running', clinic: CLINIC_NAME }));

// ─── Retell function tool handler ─────────────────────────────────────────────
app.post('/retell-functions', async (req, res) => {
  const { name, arguments: args } = req.body;
  console.log(`[CALL] Tool: ${name}`, args);

  try {
    switch (name) {
      case 'check_availability':
        return res.json(await checkAvailability(args));
      case 'book_appointment':
        return res.json(await bookAppointment(args));
      case 'get_appointments':
        return res.json(await getAppointments(args));
      case 'reschedule_appointment':
        return res.json(await rescheduleAppointment(args));
      case 'cancel_appointment':
        return res.json(await cancelAppointment(args));
      case 'send_confirmation':
        return res.json(await sendConfirmation(args));
      default:
        return res.json({ success: false, message: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`[ERROR] ${name}:`, err.message);
    return res.json({ success: false, message: 'Something went wrong. Please try again or I can transfer you to staff.' });
  }
});

// ─── Retell webhook (call events) ─────────────────────────────────────────────
app.post('/retell-webhook', (req, res) => {
  const { event, call } = req.body;
  console.log(`[WEBHOOK] ${event} — call_id: ${call?.call_id}`);
  res.sendStatus(200);
});

// ─── Tool: check_availability ─────────────────────────────────────────────────
async function checkAvailability({ preferred_date, service_name, duration_minutes = 60 }) {
  const calendar = await getCalendar();
  const date = preferred_date ? new Date(preferred_date) : new Date();

  // Look at the requested day
  const dayStart = new Date(date);
  dayStart.setHours(9, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(18, 0, 0, 0);

  const existing = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  const booked = (existing.data.items || []).map(e => ({
    start: new Date(e.start.dateTime),
    end: new Date(e.end.dateTime),
  }));

  // Generate slots every 60 min between 9am-5pm
  const slots = [];
  let slotTime = new Date(dayStart);
  while (slotTime.getHours() < 17) {
    const slotEnd = new Date(slotTime.getTime() + duration_minutes * 60000);
    const conflict = booked.some(b => slotTime < b.end && slotEnd > b.start);
    if (!conflict) {
      slots.push({
        time: slotTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
        datetime: slotTime.toISOString(),
      });
    }
    slotTime = new Date(slotTime.getTime() + 60 * 60000);
  }

  if (slots.length === 0) {
    return { available: false, message: `No availability on ${formatDate(date)} for ${service_name || 'that service'}. Would you like me to check another day?` };
  }

  const topSlots = slots.slice(0, 3);
  return {
    available: true,
    date: formatDate(date),
    service: service_name,
    slots: topSlots,
    message: `I have ${topSlots.length} openings on ${formatDate(date)}: ${topSlots.map(s => s.time).join(', ')}. Which works best for you?`,
  };
}

// ─── Tool: book_appointment ───────────────────────────────────────────────────
async function bookAppointment({ patient_name, patient_phone, service_name, datetime, notes = '' }) {
  const calendar = await getCalendar();
  const start = new Date(datetime);
  const end = new Date(start.getTime() + 60 * 60000);

  const event = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: {
      summary: `${service_name} — ${patient_name}`,
      description: `Patient: ${patient_name}\nPhone: ${patient_phone}\nService: ${service_name}\n${notes ? 'Notes: ' + notes : ''}\nBooked via AI Receptionist`,
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() },
    },
  });

  // Send SMS confirmation
  if (patient_phone && twilioClient) {
    await sendSMS(patient_phone,
      `Hi ${patient_name}! Your ${service_name} at ${CLINIC_NAME} is confirmed for ${formatDate(start)} at ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. To cancel/reschedule call ${CLINIC_PHONE}. See you soon!`
    );
  }

  return {
    success: true,
    event_id: event.data.id,
    message: `Perfect! I've booked your ${service_name} for ${formatDate(start)} at ${start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. You'll receive a confirmation text shortly.`,
  };
}

// ─── Tool: get_appointments ───────────────────────────────────────────────────
async function getAppointments({ patient_phone, patient_name }) {
  const calendar = await getCalendar();
  const now = new Date();
  const future = new Date(now.getTime() + 30 * 24 * 60 * 60000);

  const events = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
    q: patient_name || patient_phone,
  });

  const appointments = (events.data.items || []).map(e => ({
    id: e.id,
    summary: e.summary,
    start: e.start.dateTime,
    formatted: `${e.summary} on ${formatDate(new Date(e.start.dateTime))} at ${new Date(e.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`,
  }));

  if (appointments.length === 0) {
    return { found: false, message: `I don't see any upcoming appointments for ${patient_name || 'that number'}. Would you like to book one?` };
  }

  return {
    found: true,
    appointments,
    message: `I found ${appointments.length} upcoming appointment${appointments.length > 1 ? 's' : ''}: ${appointments.map(a => a.formatted).join('; ')}.`,
  };
}

// ─── Tool: reschedule_appointment ─────────────────────────────────────────────
async function rescheduleAppointment({ event_id, new_datetime, patient_name, patient_phone }) {
  const calendar = await getCalendar();
  const event = await calendar.events.get({ calendarId: CALENDAR_ID, eventId: event_id });
  const duration = new Date(event.data.end.dateTime) - new Date(event.data.start.dateTime);
  const newStart = new Date(new_datetime);
  const newEnd = new Date(newStart.getTime() + duration);

  await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId: event_id,
    resource: {
      start: { dateTime: newStart.toISOString() },
      end: { dateTime: newEnd.toISOString() },
    },
  });

  if (patient_phone && twilioClient) {
    await sendSMS(patient_phone,
      `Hi ${patient_name}! Your appointment at ${CLINIC_NAME} has been rescheduled to ${formatDate(newStart)} at ${newStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. Questions? Call ${CLINIC_PHONE}.`
    );
  }

  return {
    success: true,
    message: `Done! I've moved your appointment to ${formatDate(newStart)} at ${newStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}. A confirmation text is on its way.`,
  };
}

// ─── Tool: cancel_appointment ─────────────────────────────────────────────────
async function cancelAppointment({ event_id, patient_name, patient_phone, reason = '' }) {
  const calendar = await getCalendar();
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: event_id });

  if (patient_phone && twilioClient) {
    await sendSMS(patient_phone,
      `Hi ${patient_name}, your appointment at ${CLINIC_NAME} has been cancelled. We hope to see you again soon! Book online or call ${CLINIC_PHONE}.`
    );
  }

  return {
    success: true,
    message: `Your appointment has been cancelled. ${reason ? 'I\'ve noted: ' + reason + '. ' : ''}We hope to see you again soon — would you like to reschedule?`,
  };
}

// ─── Tool: send_confirmation ──────────────────────────────────────────────────
async function sendConfirmation({ patient_phone, patient_name, message }) {
  if (!patient_phone || !twilioClient) {
    return { success: false, message: 'SMS not configured.' };
  }
  await sendSMS(patient_phone, message || `Thank you for calling ${CLINIC_NAME}, ${patient_name}! We look forward to seeing you.`);
  return { success: true, message: 'Confirmation sent.' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendSMS(to, body) {
  if (!twilioClient) return;
  try {
    await twilioClient.messages.create({ to, from: TWILIO_FROM, body });
    console.log(`[SMS] Sent to ${to}`);
  } catch (e) {
    console.error('[SMS ERROR]', e.message);
  }
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Receptionist running on port ${PORT}`));
