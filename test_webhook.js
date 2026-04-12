import request from 'supertest';
import express from 'express';
import monetizationRouter from './api/monetization.js';

const app = express();
app.use('/api', monetizationRouter);

async function run() {
  const res = await request(app)
    .post('/api/webhook/stripe')
    .set('stripe-signature', 'test-sig')
    .send({
      type: 'checkout.session.completed',
      data: {
        object: {
          customer: 'cust_123',
          customer_email: 'test@example.com',
          metadata: { tier: 'PRO' },
          subscription: 'sub_123'
        }
      }
    });
  console.log(res.status, res.body);
}

run();
