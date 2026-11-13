const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(cors());
app.use(express.json());

let queueState = {
    finance: {
        current: '---', window: '---', counter: 1,
        queue: [],
        activeWindows: [],
        servingTicket: null,
        heldTickets: [] // NEW: Holds tickets for this dept
    },
    registrar: {
        current: '---', window: '---', counter: 1,
        queue: [],
        activeWindows: [],
        servingTicket: null,
        heldTickets: []
    }
};

let clients = [];

function logTerminalStatus(dept, ticket) {
    const now = new Date();
    const date = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getFullYear()).slice(-2)}`;
    const logsDir = path.join(__dirname, 'logs');
    const logFile = path.join(logsDir, `${date}.json`);

    fs.mkdirSync(logsDir, { recursive: true });
    let entries = [];
    if (fs.existsSync(logFile)) {
        try {
            entries = JSON.parse(fs.readFileSync(logFile, 'utf8'));
            if (!Array.isArray(entries)) entries = [];
        } catch (error) {
            console.error('Unable to read ticket status log:', error);
        }
    }

    entries.push({ dept, ...ticket, loggedAt: now.toISOString() });
    fs.writeFileSync(logFile, JSON.stringify(entries, null, 2));
}

// SSE Stream Endpoint (For TV screens AND Staff panels)
app.get('/api/queue-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial state immediately upon connection
    res.write(`data: ${JSON.stringify(queueState)}\n\n`);

    const clientId = Date.now();
    clients.push({ id: clientId, res });

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

app.post('/api/issue-ticket', (req, res) => {
    const { dept, idno, transaction } = req.body;

    if (!queueState[dept]) {
        return res.status(400).json({ message: "Invalid department" });
    }

    const counter = queueState[dept].counter++;
    const prefix = dept === 'finance' ? 'F' : 'R';
    const number = `${prefix}-${String(counter).padStart(3, '0')}`;

    const newTicket = {
        number,
        idno,
        transaction,
        status: 'open', // open, calling, processing, hold, void, closed
        window: null,
        timeIssued: Date.now(),
        timeProcessing: null,
        timeHold: null,
        timeClosed: null
    };

    queueState[dept].queue.push(newTicket);

    broadcast(queueState);
    res.json({ success: true, ticket: newTicket, state: queueState });
});

app.post('/api/call-next', (req, res) => {
    const { dept, window } = req.body;
    const state = queueState[dept];

    if (!state || state.queue.length === 0) {
        return res.status(400).json({ message: "Queue is empty" });
    }

    const currentTicket = state.activeWindows.find(w => w.window === window);

    // 1. Auto-void current ticket if window was occupied
    if (currentTicket && currentTicket.status !== 'closed') {
        state.servingTicket.status = 'void';
        state.servingTicket.timeClosed = Date.now();
        state.servingTicket = null;
    }

    // 2. Call next
    const nextCustomer = state.queue.shift();
    nextCustomer.status = 'calling';
    nextCustomer.window = window;

    state.current = nextCustomer.number;
    state.window = window;
    state.servingTicket = nextCustomer;

    // Update active windows
    state.activeWindows = state.activeWindows.filter(w => w.window !== window);
    state.activeWindows.unshift(nextCustomer);

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

// 3. UPDATE STATUS (From Staff Panel)
app.post('/api/update-status', (req, res) => {
    const { dept, window, status } = req.body;
    const state = queueState[dept];
    const ticket = state.activeWindows.find(w => w.window === window);


    if (!ticket) {
        return res.status(400).json({ message: "No active ticket found at this window" });
    }

    if (ticket.status === "closed")
        return res.status(400).json({ message: `Ticket ${ticket.number} is already closed` });

    ticket.status = status;

    if (status === 'processing') {
        ticket.timeProcessing = Date.now();
    }
    else if (status === 'hold') {
        ticket.timeHold = Date.now();
        // Move to held tickets
        state.heldTickets.push(ticket);

        // Clear the window's current display
        state.servingTicket = null;
        state.current = '---';
        state.activeWindows = state.activeWindows.filter(w => w.window !== window);
    }
    else if (status === 'closed') {
        ticket.timeClosed = Date.now();
        setTimeout(() => logTerminalStatus(dept, ticket), 1000); // Delay logging to ensure status is updated
    }

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

// NEW: Resume Ticket
app.post('/api/resume-ticket', (req, res) => {
    const { dept, window, ticketNumber } = req.body;
    const state = queueState[dept];

    // Find the ticket in heldTickets
    const ticketIndex = state.heldTickets.findIndex(t => t.number === ticketNumber && t.window === window);

    if (ticketIndex === -1) {
        return res.status(400).json({ message: "Ticket not found in hold list" });
    }

    // Remove from hold, set as current
    const ticket = state.heldTickets.splice(ticketIndex, 1)[0];
    ticket.status = 'processing'; // Resume directly to processing
    ticket.window = window;

    state.servingTicket = ticket;
    state.current = ticket.number;
    state.window = window;
    state.activeWindows = state.activeWindows.filter(w => w.window !== window);
    state.activeWindows.unshift(ticket);

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

app.post('/api/clear-window', (req, res) => {
    const { dept, window } = req.body;
    const state = queueState[dept];

    if (!state) return res.status(400).json({ message: "Invalid department" });

    const ticket = state.activeWindows.find(w => w.window === window);

    // 1. Auto-void current ticket if it exists
    if (ticket && ticket.status !== 'closed') {
        ticket.status = 'void';
        ticket.timeClosed = Date.now();
        setTimeout(() => logTerminalStatus(dept, ticket), 1000);
    }

    // 2. Clear window state
    state.activeWindows = state.activeWindows.filter(w => w.window !== window);

    if (state.window === window) {
        state.window = '---';
        state.current = '---';
    }

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

function broadcast(data) {
    clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
    // console.log('Broadcasted new state to clients:', JSON.stringify(queueState, null, 2));
}

app.listen(3000, () => console.log('Queue Server running on port 3000'));