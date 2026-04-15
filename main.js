import { AppController } from './controller/AppController.js';

const canvas = document.getElementById('canvas');
const uiOverlay = document.getElementById('ui-overlay');

const app = new AppController(canvas, uiOverlay);
app.start();
