const map = L.map('map', { zoomControl: false, preferCanvas: true }).setView([33.5902, 130.4017], 15);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const els = {
  load: document.getElementById('loadAreaButton'),
  status: document.getElementById('status'),
  sheet