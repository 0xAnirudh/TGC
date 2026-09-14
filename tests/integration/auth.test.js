import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../packages/api/src/app.js';
import { setupStores, resetStores, teardownStores } from '../helpers/stores.js';

const app = createApp();
const goodPassword = 'correct-horse-battery';

const registerBody = (over = {}) => ({
  username: 'trader_one',
  password: goodPassword,
  ...over,
});

beforeAll(setupStores);
afterAll(teardownStores);
beforeEach(resetStores);

describe('POST /auth/register', () => {
  it('creates an account with the starting grant and returns a token', async () => {
    const res = await request(app).post('/auth/register').send(registerBody()).expect(201);

    expect(res.body.user.username).toBe('trader_one');
    expect(typeof res.body.token).toBe('string');
    // A player has no persistent balance. Money belongs to a run, and a
    // run has not started yet.
    expect(res.body.user.cash).toBeUndefined();
  });

  it('never returns the password hash', async () => {
    const res = await request(app).post('/auth/register').send(registerBody()).expect(201);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it('rejects a duplicate username', async () => {
    await request(app).post('/auth/register').send(registerBody()).expect(201);
    const res = await request(app).post('/auth/register').send(registerBody()).expect(409);
    expect(res.body.error).toBe('username_taken');
  });

  it('rejects a duplicate that differs only in case', async () => {
    // "Trader" and "trader" are the same account to anyone reading a
    // leaderboard, so allowing both is an impersonation vector.
    await request(app)
      .post('/auth/register')
      .send(registerBody({ username: 'Trader' }));
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ username: 'trader' }))
      .expect(409);
    expect(res.body.error).toBe('username_taken');
  });

  it.each([
    ['username too short', { username: 'ab' }],
    ['username too long', { username: 'a'.repeat(21) }],
    ['username with punctuation', { username: 'bad-name!' }],
    ['password too short', { password: 'short' }],
  ])('rejects %s', async (_label, over) => {
    const res = await request(app).post('/auth/register').send(registerBody(over)).expect(400);
    expect(res.body.error).toBe('validation_failed');
    expect(res.body.details.length).toBeGreaterThan(0);
  });

  it('rejects a password longer than bcrypt actually hashes', async () => {
    // bcrypt silently ignores everything past 72 bytes, so two long
    // passwords sharing a prefix would hash identically. Rejecting is
    // the honest option.
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ password: 'a'.repeat(73) }))
      .expect(400);
    expect(res.body.details[0].message).toMatch(/72 bytes/);
  });

  it('counts bytes rather than characters in that limit', async () => {
    // 40 multi-byte characters are under the 72 character mark but well
    // over the 72 byte one.
    const res = await request(app)
      .post('/auth/register')
      .send(registerBody({ password: '🔑'.repeat(40) }))
      .expect(400);
    expect(res.body.details[0].message).toMatch(/72 bytes/);
  });
});

describe('POST /auth/login', () => {
  beforeEach(async () => {
    await request(app).post('/auth/register').send(registerBody());
  });

  it('issues a token for correct credentials', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'trader_one', password: goodPassword })
      .expect(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.username).toBe('trader_one');
  });

  it('accepts the username in any case', async () => {
    await request(app)
      .post('/auth/login')
      .send({ username: 'TRADER_ONE', password: goodPassword })
      .expect(200);
  });

  it('rejects a wrong password', async () => {
    const res = await request(app)
      .post('/auth/login')
      .send({ username: 'trader_one', password: 'wrong-password' })
      .expect(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('gives an unknown account exactly the same answer as a wrong password', async () => {
    // Any difference between these two responses is a free
    // account-enumeration oracle.
    const wrongPassword = await request(app)
      .post('/auth/login')
      .send({ username: 'trader_one', password: 'wrong-password' });
    const noSuchUser = await request(app)
      .post('/auth/login')
      .send({ username: 'ghost_account', password: goodPassword });

    expect(noSuchUser.status).toBe(wrongPassword.status);
    expect(noSuchUser.body).toEqual(wrongPassword.body);
  });
});

describe('GET /me', () => {
  let token;
  let userId;

  beforeEach(async () => {
    const res = await request(app).post('/auth/register').send(registerBody());
    token = res.body.token;
    userId = res.body.user.id;
  });

  it('returns the account for a valid token', async () => {
    const res = await request(app).get('/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(res.body.user.id).toBe(userId);
    expect(res.body.user.username).toBe('trader_one');
  });

  it.each([
    ['no header', undefined, 'missing_token'],
    ['a bare token with no scheme', 'sometoken', 'malformed_token'],
    ['the wrong scheme', 'Basic sometoken', 'malformed_token'],
    ['a garbage token', 'Bearer not-a-jwt', 'invalid_token'],
  ])('rejects %s', async (_label, header, code) => {
    const req = request(app).get('/me');
    if (header) req.set('Authorization', header);
    const res = await req.expect(401);
    expect(res.body.error).toBe(code);
  });

  it('rejects a token signed with a different secret', async () => {
    const forged = jwt.sign({ sub: userId, username: 'trader_one' }, 'not-the-real-secret');
    const res = await request(app).get('/me').set('Authorization', `Bearer ${forged}`).expect(401);
    expect(res.body.error).toBe('invalid_token');
  });

  it('tells an expired token apart from an invalid one', async () => {
    // The client can act on expiry by re-logging in; it can do nothing
    // about a bad signature, so the two are worth distinguishing.
    const expired = jwt.sign({ sub: userId, username: 'trader_one' }, process.env.JWT_SECRET, {
      expiresIn: '-1s',
    });
    const res = await request(app).get('/me').set('Authorization', `Bearer ${expired}`).expect(401);
    expect(res.body.error).toBe('token_expired');
  });
});
