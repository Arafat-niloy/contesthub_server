const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.tm8Q.mongodb.net/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // await client.connect();
    const db = client.db("contestHubDB");
    const userCollection = db.collection("users");
    const contestCollection = db.collection("contests");
    const paymentCollection = db.collection("payments");

    // JWT Generator
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
      res.send({ token });
    });
// Verify Token Middleware
    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) return res.status(401).send({ message: 'forbidden access' });
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) return res.status(401).send({ message: 'forbidden access' });
        req.decoded = decoded;
        next();
      });
    };

    // Verify Admin Middleware
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      if (user?.role !== 'admin') return res.status(403).send({ message: 'forbidden access' });
      next();
    };

    // Verify Creator Middleware
    const verifyCreator = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      if (user?.role !== 'creator' && user?.role !== 'admin') return res.status(403).send({ message: 'forbidden access' });
      next();
    };

    // --- USERS API ---
    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) return res.send({ message: 'user already exists', insertedId: null });
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get('/users/role/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) return res.status(403).send({ message: 'unauthorized' });
      const query = { email: email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role });
    });

    app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
        const id = req.params.id;
        const role = req.body.role;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: { role: role } };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
    });

    app.put('/users/:email', verifyToken, async (req, res) => {
        const email = req.params.email;
        const data = req.body;
        const filter = { email: email };
        const updatedDoc = { $set: { ...data } };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
    });

    // --- CONTESTS API ---
    app.post('/contests', verifyToken, verifyCreator, async (req, res) => {
      const contest = req.body;
      const result = await contestCollection.insertOne(contest);
      res.send(result);
    });

    app.get('/contests', async (req, res) => {
        const search = req.query.search || "";
        const type = req.query.type || "";
        let query = {
            status: 'accepted',
            contestName: { $regex: search, $options: 'i' }
        };
        if(type && type !== 'All') {
            query.contestType = type;
        }
        const result = await contestCollection.find(query).toArray();
        res.send(result);
    });

    
    

    
  } finally {}
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`ContestHub is sitting on port ${port}`);
});