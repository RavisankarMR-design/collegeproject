// One place to turn a caught exception into a response, so internals (Mongo
// error text, stack fragments, field names) never reach the client.
function serverError(res, err) {
  if (err && err.name === 'CastError') return res.status(400).json({ error: 'Invalid id.' });
  if (err && err.name === 'ValidationError') return res.status(400).json({ error: 'Invalid input.' });
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong — please try again.' });
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

module.exports = { serverError, isNum };
