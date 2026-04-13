require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── JSON store ───────────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'db.json');
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { appointments: [] }; }
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── Timezone helpers ─────────────────────────────────────────────────────────
// All date logic uses the clinic's local timezone so Railway (UTC) never
// reports the wrong calendar day to US callers.
const CLINIC_TZ = process.env.CLINIC_TIMEZONE || 'America/New_York';

function todayInTZ() {
  // Returns YYYY-MM-DD in clinic timezone
  return new Date().toLocaleDateString('en-CA', { timeZone: CLINIC_TZ });
}

function nowFormatted() {
  // Human-readable "Monday, April 13" in clinic timezone
  return new Date().toLocaleDateString('en-US', {
    timeZone: CLINIC_TZ, weekday: 'long', month: 'long', day: 'numeric'
  });
}

function dayOfWeekInTZ(dateStr) {
  // 0=Sun … 6=Sat for a YYYY-MM-DD string, evaluated at noon clinic time
  const d = new Date(dateStr + 'T12:00:00');
  return parseInt(
    new Intl.DateTimeFormat('en-US', { timeZone: CLINIC_TZ, weekday: 'short' })
      .formatToParts(d)
      .find(p => p.type === 'weekday')
      // map abbreviated weekday → JS day number
      .value === 'Sun' ? 0 :
    ['Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
      new Intl.DateTimeFormat('en-US', { timeZone: CLINIC_TZ, weekday: 'short' })
        .format(d).slice(0,3)
    ) + 1
  );
}

// ─── Config ───────────────────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const CLINIC_NAME   = process.env.CLINIC_NAME        || 'Luxe Medical Spa';
const CLINIC_PHONE  = process.env.CLINIC_PHONE        || '(555) 000-0000';
const CLINIC_EMAIL  = process.env.CLINIC_EMAIL        || 'appointments@luxemedicalspa.com';
const TWILIO_FROM   = process.env.TWILIO_FROM_NUMBER  || '';
const RESEND_KEY    = process.env.RESEND_API_KEY      || '';

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const data = readDB();
  const confirmed = data.appointments.filter(a => a.status === 'confirmed').length;
  res.json({ status: 'AI Receptionist running', clinic: CLINIC_NAME, confirmed_appointments: confirmed });
});

app.get('/appointments', (req, res) => {
  const data = readDB();
  res.json(data.appointments.sort((a, b) => a.datetime.localeCompare(b.datetime)));
});

app.post('/retell-functions', async (req, res) => {
  const { name } = req.body;
  const args = req.body.args || req.body.arguments || {};
  console.log(`[TOOL] ${name}`, JSON.stringify(args));
  try {
    const handlers = {
      check_availability:     () => checkAvailability(args),
      book_appointment:       () => bookAppointment(args),
      get_appointments:       () => getAppointments(args),
      reschedule_appointment: () => rescheduleAppointment(args),
      cancel_appointment:     () => cancelAppointment(args),
    };
    const handler = handlers[name];
    if (!handler) return res.json({ success: false, message: `I'm not sure how to handle that — let me get someone from the team for you.` });
    const result = await handler();
    console.log(`[TOOL RESULT] ${name}:`, JSON.stringify(result));
    return res.json(result);
  } catch (err) {
    console.error(`[ERROR] ${name}:`, err.message, err.stack);
    return res.json({ success: true, message: `Got it — let me get you booked and one of our team members will confirm the details with you shortly.` });
  }
});

app.post('/retell-webhook', (req, res) => {
  console.log(`[WEBHOOK]`, JSON.stringify(req.body));
  res.sendStatus(200);
});

// ─── Tool functions ───────────────────────────────────────────────────────────
function checkAvailability({ preferred_date, service_name } = {}) {
  const todayStr = todayInTZ();                            // YYYY-MM-DD in clinic TZ
  const dateStr  = preferred_date || todayStr;
  const date     = new Date(dateStr + 'T12:00:00');        // noon = safe day anchor

  // Block past dates
  if (dateStr < todayStr) {
    return { available: false, today: todayStr, today_formatted: nowFormatted(), message: `That date has already passed. The earliest I can book you is today, ${nowFormatted()} — want to check availability?` };
  }

  // Block Sundays
  if (dayOfWeekInTZ(dateStr) === 0) {
    const monday = new Date(date);
    monday.setDate(monday.getDate() + 1);
    const mondayStr = monday.toLocaleDateString('en-CA', { timeZone: CLINIC_TZ });
    return { available: false, today: todayStr, today_formatted: nowFormatted(), message: `We're closed on Sundays. The next available day is ${formatDate(monday)} — want me to check that?` };
  }

  const data     = readDB();

  const bookedHours = data.appointments
    .filter(a => a.status === 'confirmed' && a.datetime.startsWith(dateStr))
    .map(a => new Date(a.datetime).getHours());

  const freeSlots = [9,10,11,12,13,14,15,16].filter(h => !bookedHours.includes(h));

  if (!freeSlots.length) {
    const tomorrow = new Date(date);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split('T')[0];
    const tomorrowBooked = data.appointments
      .filter(a => a.status === 'confirmed' && a.datetime.startsWith(tomorrowStr))
      .map(a => new Date(a.datetime).getHours());
    const tomorrowSlots = [9,10,11,12,13,14,15,16].filter(h => !tomorrowBooked.includes(h)).slice(0,3);
    return {
      available: false,
      today: todayStr,
      today_formatted: nowFormatted(),
      message: `${formatDate(date)} is fully booked. I do have openings on ${formatDate(tomorrow)} — ${tomorrowSlots.map(h => formatTime(h)).join(', ')}. Would any of those work?`,
      alternative_date: tomorrowStr,
      alternative_slots: tomorrowSlots.map(h => ({ time: formatTime(h), datetime: `${tomorrowStr}T${String(h).padStart(2,'0')}:00:00` }))
    };
  }

  const top = freeSlots.slice(0, 3).map(h => ({
    time: formatTime(h),
    datetime: `${dateStr}T${String(h).padStart(2,'0')}:00:00`
  }));

  return {
    available: true,
    today: todayStr,
    today_formatted: nowFormatted(),
    date: formatDate(date),
    service: service_name || 'appointment',
    slots: top,
    message: `On ${formatDate(date)} I have ${top.map(s => s.time).join(', ')} available. Which one works best for you?`
  };
}

async function bookAppointment({ patient_name, patient_phone, patient_email, service_name, datetime, notes } = {}) {
  if (!patient_name || !service_name || !datetime) {
    return { success: false, message: "I just need your name, the service you'd like, and a time — then I can get you locked in." };
  }

  const dt = new Date(datetime);

  // Block past bookings
  if (dt < new Date()) {
    return { success: false, message: "That date has already passed — let me find you an upcoming slot instead." };
  }

  // Normalize phone to E.164 for SMS
  if (patient_phone) {
    patient_phone = patient_phone.replace(/\D/g, '');
    if (patient_phone.length === 10) patient_phone = '+1' + patient_phone;
    else if (patient_phone.length === 11 && patient_phone.startsWith('1')) patient_phone = '+' + patient_phone;
  }

  const data = readDB();
  const id = crypto.randomUUID();

  const appointment = {
    id,
    patient_name,
    patient_phone:  patient_phone  || '',
    patient_email:  patient_email  || '',
    service_name,
    datetime:       dt.toISOString(),
    notes:          notes || '',
    status:         'confirmed',
    created_at:     new Date().toISOString()
  };

  data.appointments.push(appointment);
  writeDB(data);

  const dateStr   = formatDate(dt);
  const timeStr   = formatTime(dt.getHours());
  const smsBody   = `Hi ${patient_name}! ✅ Your ${service_name} at ${CLINIC_NAME} is confirmed for ${dateStr} at ${timeStr}. Questions? Call us at ${CLINIC_PHONE}. See you soon!`;
  const emailBody = buildConfirmationEmail({ patient_name, service_name, dateStr, timeStr });

  sendSMS(patient_phone, smsBody);
  await sendEmail({ to: patient_email, subject: `Appointment Confirmed — ${service_name} at ${CLINIC_NAME}`, html: emailBody });

  return {
    success: true,
    appointment_id: id,
    message: `You're all set, ${patient_name.split(' ')[0]}! Your ${service_name} is confirmed for ${dateStr} at ${timeStr}. We'll send a confirmation to your phone${patient_email ? ' and email' : ''}. Is there anything else I can help you with?`
  };
}

function getAppointments({ patient_phone, patient_name } = {}) {
  const data = readDB();
  const now  = new Date().toISOString();

  let appts = data.appointments.filter(a => a.status === 'confirmed' && a.datetime > now);
  if (patient_phone) appts = appts.filter(a => a.patient_phone === patient_phone);
  else if (patient_name) appts = appts.filter(a => a.patient_name.toLowerCase().includes(patient_name.toLowerCase()));

  if (!appts.length) return { found: false, message: `I don't see any upcoming appointments under that name or number. Want me to get you booked for something?` };

  return {
    found: true,
    appointments: appts.map(a => ({ id: a.id, service: a.service_name, datetime: a.datetime, formatted: `${a.service_name} on ${formatDate(new Date(a.datetime))} at ${formatTime(new Date(a.datetime).getHours())}` })),
    message: `I found ${appts.length} upcoming appointment${appts.length > 1 ? 's' : ''}: ${appts.map(a => `${a.service_name} on ${formatDate(new Date(a.datetime))} at ${formatTime(new Date(a.datetime).getHours())}`).join('; ')}.`
  };
}

async function rescheduleAppointment({ event_id, appointment_id, new_datetime, patient_name, patient_phone } = {}) {
  const id   = event_id || appointment_id;
  const data = readDB();
  const appt = data.appointments.find(a => a.id === id);

  if (!appt) return { success: false, message: `I couldn't find that appointment. Can you double-check your name or phone number for me?` };

  const newDt = new Date(new_datetime);
  appt.datetime = newDt.toISOString();
  writeDB(data);

  const smsBody = `Hi ${patient_name || appt.patient_name}! Your ${appt.service_name} at ${CLINIC_NAME} has been moved to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}. See you then!`;
  sendSMS(patient_phone || appt.patient_phone, smsBody);
  await sendEmail({ to: appt.patient_email, subject: `Appointment Rescheduled — ${CLINIC_NAME}`, html: `<p>Your ${appt.service_name} has been rescheduled to <strong>${formatDate(newDt)} at ${formatTime(newDt.getHours())}</strong>.</p>` });

  return { success: true, message: `Done! I've moved your ${appt.service_name} to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}. You'll get a confirmation text shortly.` };
}

async function cancelAppointment({ event_id, appointment_id, patient_name, patient_phone, reason } = {}) {
  const id   = event_id || appointment_id;
  const data = readDB();
  const appt = data.appointments.find(a => a.id === id);

  if (!appt) return { success: false, message: `I couldn't pull up that appointment. Can you give me your name or phone number again?` };

  appt.status = 'cancelled';
  writeDB(data);

  sendSMS(patient_phone || appt.patient_phone, `Hi ${patient_name || appt.patient_name}, your ${appt.service_name} at ${CLINIC_NAME} has been cancelled. We hope to see you again soon!`);

  return { success: true, message: `Done — your ${appt.service_name} has been cancelled. Would you like to find another time before you go?` };
}

// ─── Notifications ────────────────────────────────────────────────────────────
function sendSMS(to, body) {
  if (!to) return;
  if (!twilioClient) { console.log(`[SMS - no Twilio] → ${to}: ${body}`); return; }
  twilioClient.messages.create({ to, from: TWILIO_FROM, body })
    .then(() => console.log(`[SMS ✓] → ${to}`))
    .catch(e => console.error('[SMS ✗]', e.message));
}

async function sendEmail({ to, subject, html }) {
  if (!to) return;
  if (!RESEND_KEY) { console.log(`[EMAIL - no Resend key] → ${to}: ${subject}`); return; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `${CLINIC_NAME} <${CLINIC_EMAIL}>`, to, subject, html })
    });
    const data = await res.json();
    if (res.ok) console.log(`[EMAIL ✓] → ${to}`);
    else console.error(`[EMAIL ✗]`, data);
  } catch (e) {
    console.error('[EMAIL ✗]', e.message);
  }
}

function buildConfirmationEmail({ patient_name, service_name, dateStr, timeStr }) {
  return `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f9f9f9;">
      <div style="background:#fff;border-radius:12px;padding:32px;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
        <h2 style="color:#1a1a2e;margin-top:0;">Appointment Confirmed ✅</h2>
        <p style="color:#444;">Hi ${patient_name},</p>
        <p style="color:#444;">Your appointment is confirmed. Here are your details:</p>
        <div style="background:#f0f4ff;border-radius:8px;padding:20px;margin:20px 0;">
          <p style="margin:4px 0;color:#333;"><strong>Service:</strong> ${service_name}</p>
          <p style="margin:4px 0;color:#333;"><strong>Date:</strong> ${dateStr}</p>
          <p style="margin:4px 0;color:#333;"><strong>Time:</strong> ${timeStr}</p>
          <p style="margin:4px 0;color:#333;"><strong>Location:</strong> ${CLINIC_NAME}</p>
        </div>
        <p style="color:#444;">Need to reschedule or cancel? Call us at <strong>${CLINIC_PHONE}</strong> or reply to this email.</p>
        <p style="color:#888;font-size:13px;margin-top:32px;">See you soon,<br/><strong>${CLINIC_NAME}</strong></p>
      </div>
    </div>
  `;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', { timeZone: CLINIC_TZ, weekday: 'long', month: 'long', day: 'numeric' });
}
function formatTime(hour) {
  const d = new Date(); d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${CLINIC_NAME} AI Receptionist running on port ${PORT}`));
