require('dotenv').config();
const express = require('express');
const twilio  = require('twilio');
const crypto  = require('crypto');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

// ─── Simple JSON store ────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'db.json');

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { appointments: [] }; }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ─── Config ───────────────────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const CLINIC_NAME  = process.env.CLINIC_NAME       || 'Luxe Medical Spa';
const CLINIC_PHONE = process.env.CLINIC_PHONE       || '';
const TWILIO_FROM  = process.env.TWILIO_FROM_NUMBER || '';

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const data = readDB();
  const confirmed = data.appointments.filter(a => a.status === 'confirmed').length;
  res.json({ status: 'AI Receptionist running', clinic: CLINIC_NAME, confirmed_appointments: confirmed });
});

app.get('/appointments', (req, res) => {
  const data = readDB();
  const sorted = data.appointments.sort((a, b) => a.datetime.localeCompare(b.datetime));
  res.json(sorted);
});

app.post('/retell-functions', (req, res) => {
  const { name, arguments: args } = req.body;
  console.log(`[TOOL] ${name}`, JSON.stringify(args));
  try {
    const handlers = {
      check_availability:     () => checkAvailability(args),
      book_appointment:       () => bookAppointment(args),
      get_appointments:       () => getAppointments(args),
      reschedule_appointment: () => rescheduleAppointment(args),
      cancel_appointment:     () => cancelAppointment(args),
      send_confirmation:      () => sendConfirmationTool(args),
    };
    const handler = handlers[name];
    if (!handler) return res.json({ success: false, message: `Unknown tool: ${name}` });
    return res.json(handler());
  } catch (err) {
    console.error(`[ERROR] ${name}:`, err.message, err.stack);
    return res.json({ success: false, message: 'Something went wrong. Let me transfer you to a team member.' });
  }
});

app.post('/retell-webhook', (req, res) => {
  console.log(`[WEBHOOK] ${req.body?.event}`);
  res.sendStatus(200);
});

// ─── Tool functions ───────────────────────────────────────────────────────────
function checkAvailability({ preferred_date, service_name }) {
  const date    = new Date(preferred_date || Date.now());
  const dateStr = date.toISOString().split('T')[0];
  const data    = readDB();

  const bookedHours = data.appointments
    .filter(a => a.status === 'confirmed' && a.datetime.startsWith(dateStr))
    .map(a => new Date(a.datetime).getHours());

  const freeSlots = [9,10,11,12,13,14,15,16].filter(h => !bookedHours.includes(h));

  if (!freeSlots.length) {
    return { available: false, message: `No availability on ${formatDate(date)}. Would you like to check a different day?` };
  }

  const top = freeSlots.slice(0, 3).map(h => ({
    time: formatTime(h),
    datetime: `${dateStr}T${String(h).padStart(2,'0')}:00:00`
  }));

  return {
    available: true,
    date: formatDate(date),
    service: service_name,
    slots: top,
    message: `I have openings on ${formatDate(date)} at: ${top.map(s => s.time).join(', ')}. Which works best for you?`
  };
}

function bookAppointment({ patient_name, patient_phone, service_name, datetime, notes }) {
  const data = readDB();
  const id   = crypto.randomUUID();
  const dt   = new Date(datetime);

  data.appointments.push({
    id, patient_name, patient_phone, service_name,
    datetime: dt.toISOString(), notes: notes || '',
    status: 'confirmed', created_at: new Date().toISOString()
  });
  writeDB(data);

  sendSMS(patient_phone,
    `Hi ${patient_name}! Your ${service_name} at ${CLINIC_NAME} is confirmed for ${formatDate(dt)} at ${formatTime(dt.getHours())}. To cancel/reschedule call ${CLINIC_PHONE}. See you soon!`
  );

  return {
    success: true,
    appointment_id: id,
    message: `Perfect! Your ${service_name} is booked for ${formatDate(dt)} at ${formatTime(dt.getHours())}. A confirmation text is on its way. Is there anything else I can help you with?`
  };
}

function getAppointments({ patient_phone, patient_name }) {
  const data = readDB();
  const now  = new Date().toISOString();

  let appts = data.appointments.filter(a => a.status === 'confirmed' && a.datetime > now);
  if (patient_phone) appts = appts.filter(a => a.patient_phone === patient_phone);
  else if (patient_name) appts = appts.filter(a => a.patient_name.toLowerCase().includes(patient_name.toLowerCase()));

  if (!appts.length) return { found: false, message: `No upcoming appointments found. Would you like to book one?` };

  return {
    found: true,
    appointments: appts.map(a => ({ id: a.id, service: a.service_name, datetime: a.datetime })),
    message: `Found ${appts.length} appointment${appts.length>1?'s':''}: ${appts.map(a=>`${a.service_name} on ${formatDate(new Date(a.datetime))} at ${formatTime(new Date(a.datetime).getHours())}`).join('; ')}.`
  };
}

function rescheduleAppointment({ appointment_id, new_datetime, patient_name, patient_phone }) {
  const data = readDB();
  const appt = data.appointments.find(a => a.id === appointment_id);
  if (!appt) return { success: false, message: "I couldn't find that appointment." };

  const newDt = new Date(new_datetime);
  appt.datetime = newDt.toISOString();
  writeDB(data);

  sendSMS(patient_phone || appt.patient_phone,
    `Hi ${patient_name || appt.patient_name}! Your appointment at ${CLINIC_NAME} has been rescheduled to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}.`
  );

  return { success: true, message: `Done! Moved your ${appt.service_name} to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}. Confirmation text sent.` };
}

function cancelAppointment({ appointment_id, patient_name, patient_phone }) {
  const data = readDB();
  const appt = data.appointments.find(a => a.id === appointment_id);
  if (!appt) return { success: false, message: "I couldn't find that appointment." };

  appt.status = 'cancelled';
  writeDB(data);

  sendSMS(patient_phone || appt.patient_phone,
    `Hi ${patient_name || appt.patient_name}, your ${appt.service_name} at ${CLINIC_NAME} has been cancelled. We hope to see you again!`
  );

  return { success: true, message: `Your ${appt.service_name} has been cancelled. Would you like to reschedule?` };
}

function sendConfirmationTool({ patient_phone, patient_name, message }) {
  sendSMS(patient_phone, message || `Thank you for calling ${CLINIC_NAME}, ${patient_name}!`);
  return { success: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendSMS(to, body) {
  if (!twilioClient || !to) return;
  twilioClient.messages.create({ to, from: TWILIO_FROM, body })
    .then(() => console.log(`[SMS] → ${to}`))
    .catch(e => console.error('[SMS]', e.message));
}

function formatDate(date) {
  return new Date(date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(hour) {
  const d = new Date(); d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${CLINIC_NAME} AI Receptionist running on port ${PORT}`));
