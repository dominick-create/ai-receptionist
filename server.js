require('dotenv').config();
const express = require('express');
const twilio = require('twilio');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ─── Database setup ───────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'appointments.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    patient_name TEXT NOT NULL,
    patient_phone TEXT NOT NULL,
    service_name TEXT NOT NULL,
    datetime TEXT NOT NULL,
    notes TEXT,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ─── Twilio ───────────────────────────────────────────────────────────────────
const twilioClient = process.env.TWILIO_ACCOUNT_SID
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const CLINIC_NAME = process.env.CLINIC_NAME || 'Luxe Medical Spa';
const CLINIC_PHONE = process.env.CLINIC_PHONE || '';
const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER || '';

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: 'AI Receptionist running',
  clinic: CLINIC_NAME,
  appointments: db.prepare('SELECT COUNT(*) as count FROM appointments WHERE status = ?').get('confirmed').count
}));

// ─── Admin: view all appointments ─────────────────────────────────────────────
app.get('/appointments', (req, res) => {
  const appts = db.prepare('SELECT * FROM appointments ORDER BY datetime ASC').all();
  res.json(appts);
});

// ─── Retell function tool handler ─────────────────────────────────────────────
app.post('/retell-functions', (req, res) => {
  const { name, arguments: args } = req.body;
  console.log(`[CALL] Tool: ${name}`, JSON.stringify(args));

  try {
    switch (name) {
      case 'check_availability':
        return res.json(checkAvailability(args));
      case 'book_appointment':
        return res.json(bookAppointment(args));
      case 'get_appointments':
        return res.json(getAppointments(args));
      case 'reschedule_appointment':
        return res.json(rescheduleAppointment(args));
      case 'cancel_appointment':
        return res.json(cancelAppointment(args));
      case 'send_confirmation':
        return res.json(sendConfirmationTool(args));
      default:
        return res.json({ success: false, message: `Unknown tool: ${name}` });
    }
  } catch (err) {
    console.error(`[ERROR] ${name}:`, err.message);
    return res.json({ success: false, message: 'Something went wrong. Let me transfer you to a team member.' });
  }
});

// ─── Retell webhook ───────────────────────────────────────────────────────────
app.post('/retell-webhook', (req, res) => {
  const { event, call } = req.body;
  console.log(`[WEBHOOK] ${event} — call_id: ${call?.call_id}`);
  res.sendStatus(200);
});

// ─── Tool: check_availability ─────────────────────────────────────────────────
function checkAvailability({ preferred_date, service_name }) {
  const date = preferred_date ? new Date(preferred_date) : new Date();
  const dateStr = date.toISOString().split('T')[0];

  // Get booked slots for this day
  const booked = db.prepare(
    "SELECT datetime FROM appointments WHERE datetime LIKE ? AND status = 'confirmed'"
  ).all(`${dateStr}%`).map(r => new Date(r.datetime).getHours());

  // Business hours: 9am–5pm, 1-hour slots
  const allSlots = [9, 10, 11, 12, 13, 14, 15, 16];
  const available = allSlots.filter(h => !booked.includes(h));

  if (available.length === 0) {
    return {
      available: false,
      message: `No availability on ${formatDate(date)} for ${service_name || 'that service'}. Would you like to check a different day?`
    };
  }

  const topSlots = available.slice(0, 3).map(h => ({
    time: formatTime(h),
    datetime: `${dateStr}T${String(h).padStart(2,'0')}:00:00`
  }));

  return {
    available: true,
    date: formatDate(date),
    service: service_name,
    slots: topSlots,
    message: `I have ${topSlots.length} openings on ${formatDate(date)}: ${topSlots.map(s => s.time).join(', ')}. Which works best for you?`
  };
}

// ─── Tool: book_appointment ───────────────────────────────────────────────────
function bookAppointment({ patient_name, patient_phone, service_name, datetime, notes }) {
  const id = crypto.randomUUID();
  const dt = new Date(datetime);

  db.prepare(
    'INSERT INTO appointments (id, patient_name, patient_phone, service_name, datetime, notes) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, patient_name, patient_phone, service_name, dt.toISOString(), notes || '');

  // SMS confirmation
  if (patient_phone && twilioClient) {
    sendSMS(patient_phone,
      `Hi ${patient_name}! Your ${service_name} at ${CLINIC_NAME} is confirmed for ${formatDate(dt)} at ${formatTime(dt.getHours())}. To cancel/reschedule call ${CLINIC_PHONE}. See you soon!`
    );
  }

  return {
    success: true,
    appointment_id: id,
    message: `Perfect! Your ${service_name} is booked for ${formatDate(dt)} at ${formatTime(dt.getHours())}. You'll receive a confirmation text shortly. Is there anything else I can help you with?`
  };
}

// ─── Tool: get_appointments ───────────────────────────────────────────────────
function getAppointments({ patient_phone, patient_name }) {
  let appointments;
  if (patient_phone) {
    appointments = db.prepare(
      "SELECT * FROM appointments WHERE patient_phone = ? AND status = 'confirmed' AND datetime > datetime('now') ORDER BY datetime ASC"
    ).all(patient_phone);
  } else {
    appointments = db.prepare(
      "SELECT * FROM appointments WHERE patient_name LIKE ? AND status = 'confirmed' AND datetime > datetime('now') ORDER BY datetime ASC"
    ).all(`%${patient_name}%`);
  }

  if (appointments.length === 0) {
    return { found: false, message: `I don't see any upcoming appointments. Would you like to book one?` };
  }

  return {
    found: true,
    appointments: appointments.map(a => ({
      id: a.id,
      service: a.service_name,
      datetime: a.datetime,
      formatted: `${a.service_name} on ${formatDate(new Date(a.datetime))} at ${formatTime(new Date(a.datetime).getHours())}`
    })),
    message: `I found ${appointments.length} upcoming appointment${appointments.length > 1 ? 's' : ''}: ${appointments.map(a => `${a.service_name} on ${formatDate(new Date(a.datetime))} at ${formatTime(new Date(a.datetime).getHours())}`).join('; ')}.`
  };
}

// ─── Tool: reschedule_appointment ─────────────────────────────────────────────
function rescheduleAppointment({ appointment_id, new_datetime, patient_name, patient_phone }) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment_id);
  if (!appt) return { success: false, message: "I couldn't find that appointment. Let me look it up again." };

  const newDt = new Date(new_datetime);
  db.prepare('UPDATE appointments SET datetime = ? WHERE id = ?').run(newDt.toISOString(), appointment_id);

  if (patient_phone && twilioClient) {
    sendSMS(patient_phone,
      `Hi ${patient_name || appt.patient_name}! Your appointment at ${CLINIC_NAME} has been rescheduled to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}. Questions? Call ${CLINIC_PHONE}.`
    );
  }

  return {
    success: true,
    message: `Done! I've moved your ${appt.service_name} to ${formatDate(newDt)} at ${formatTime(newDt.getHours())}. A confirmation text is on its way.`
  };
}

// ─── Tool: cancel_appointment ─────────────────────────────────────────────────
function cancelAppointment({ appointment_id, patient_name, patient_phone }) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointment_id);
  if (!appt) return { success: false, message: "I couldn't find that appointment." };

  db.prepare("UPDATE appointments SET status = 'cancelled' WHERE id = ?").run(appointment_id);

  if (patient_phone && twilioClient) {
    sendSMS(patient_phone,
      `Hi ${patient_name || appt.patient_name}, your ${appt.service_name} at ${CLINIC_NAME} has been cancelled. We hope to see you again! Book anytime by calling ${CLINIC_PHONE}.`
    );
  }

  return {
    success: true,
    message: `Your ${appt.service_name} has been cancelled. We hope to see you again soon — would you like to reschedule?`
  };
}

// ─── Tool: send_confirmation ──────────────────────────────────────────────────
function sendConfirmationTool({ patient_phone, patient_name, message }) {
  if (!patient_phone || !twilioClient) return { success: false };
  sendSMS(patient_phone, message || `Thank you for calling ${CLINIC_NAME}, ${patient_name}!`);
  return { success: true, message: 'Confirmation sent.' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sendSMS(to, body) {
  if (!twilioClient) return;
  twilioClient.messages.create({ to, from: TWILIO_FROM, body })
    .then(() => console.log(`[SMS] Sent to ${to}`))
    .catch(e => console.error('[SMS ERROR]', e.message));
}

function formatDate(date) {
  return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function formatTime(hour) {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`${CLINIC_NAME} AI Receptionist running on port ${PORT}`));
