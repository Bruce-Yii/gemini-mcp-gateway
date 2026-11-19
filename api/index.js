import { createAppHandler } from '../src/vercel-app.js';

const handler = createAppHandler();

export default async (req, res) => handler(req, res);
