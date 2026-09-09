import { measureChannels } from '../core/AudioReview.js';

self.onmessage = ({ data }) => {
  try { self.postMessage({ result: measureChannels(data.channels) }); }
  catch (err) { self.postMessage({ error: err.message }); }
};
