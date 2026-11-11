const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

let queueState = {
    finance: { 
        current: '---', window: '---', next: '---', queue: [], counter: 1, 
        activeWindows: [] // Tracks all open windows for Finance
    },
    registrar: { 
        current: '---', window: '---', next: '---', queue: [], counter: 1, 
        activeWindows: [] 
    }
};

let clients = [];

// SSE Stream Endpoint (For TV screens AND Staff panels)
app.get('/api/queue-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send current state immediately
    res.write(`data: ${JSON.stringify(queueState)}\n\n`);

    const clientId = Date.now();
    clients.push({ id: clientId, res });

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
    });
});

// 1. Issue Ticket Endpoint
app.post('/api/issue-ticket', (req, res) => {
    const { dept } = req.body;
    if (!queueState[dept]) return res.status(400).json({ message: "Invalid department" });

    const counter = queueState[dept].counter++;
    const prefix = dept === 'finance' ? 'F' : 'R';
    const number = `${prefix}-${String(counter).padStart(3, '0')}`;
    
    queueState[dept].queue.push({ number });
    
    // Update the "Next" preview
    queueState[dept].next = queueState[dept].queue.length > 0 ? queueState[dept].queue[0].number : '---';

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

// 2. Call Next Endpoint
app.post('/api/call-next', (req, res) => {
    const { dept, window } = req.body;
    if (!queueState[dept]) return res.status(400).json({ message: "Invalid department" });
    if (queueState[dept].queue.length === 0) return res.status(400).json({ message: "Queue is empty" });

    const nextCustomer = queueState[dept].queue.shift();
    
    // Update the main current state
    queueState[dept].current = nextCustomer.number;
    queueState[dept].window = window;
    
    // Update activeWindows logic:
    // Remove this window from the active list if it was there previously
    queueState[dept].activeWindows = queueState[dept].activeWindows.filter(w => w.window !== window);
    // Add it to the front of the active list (so it's the most recent)
    queueState[dept].activeWindows.unshift({ window: window, number: nextCustomer.number });

    // Update next preview
    queueState[dept].next = queueState[dept].queue.length > 0 ? queueState[dept].queue[0].number : '---';

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

app.post('/api/clear-window', (req, res) => {
    const { dept, window } = req.body;
    if (!queueState[dept]) return res.status(400).json({ message: "Invalid department" });

    // Remove this window from active list
    queueState[dept].activeWindows = queueState[dept].activeWindows.filter(w => w.window !== window);
    
    // If the window being cleared is the one on the main display, set main display to the next most recent one (or ---)
    if (queueState[dept].window === window) {
        if (queueState[dept].activeWindows.length > 0) {
            queueState[dept].window = queueState[dept].activeWindows[0].window;
            queueState[dept].current = queueState[dept].activeWindows[0].number;
        } else {
            queueState[dept].window = '---';
            queueState[dept].current = '---';
        }
    }

    broadcast(queueState);
    res.json({ success: true, state: queueState });
});

function broadcast(data) {
    clients.forEach(client => client.res.write(`data: ${JSON.stringify(data)}\n\n`));
    console.log('Broadcasted new state to clients:', JSON.stringify(queueState, null, 2));
}

app.listen(3000, () => console.log('Queue Server running on port 3000'));