const express = require('express');
const app = express();

app.use(express.json({ limit: '10mb' }));
app.all('/api/page', require('./api/page'));
app.all('/api/draw', require('./api/draw'));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('http://localhost:' + PORT));
