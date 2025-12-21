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
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.nzk3833.mongodb.net/?retryWrites=true&w=majority`;

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

    // ================= JWT & MIDDLEWARES =================
    
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
      res.send({ token });
    });

    const verifyToken = (req, res, next) => {
      if (!req.headers.authorization) {
        return res.status(401).send({ message: 'unauthorized access' });
      }
      const token = req.headers.authorization.split(' ')[1];
      jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
          return res.status(401).send({ message: 'unauthorized access' });
        }
        req.decoded = decoded;
        next();
      })
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isAdmin = user?.role === 'admin';
      if (!isAdmin) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    const verifyCreator = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email: email };
      const user = await userCollection.findOne(query);
      const isCreator = user?.role === 'creator' || user?.role === 'admin';
      if (!isCreator) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      next();
    };

    // ================= STATS & PROFILE API =================

    // ১. প্রোফাইলের ডাটা (বায়ো সহ) লোড করার জন্য
    app.get('/user-profile/:email', verifyToken, async (req, res) => {
        const email = req.params.email;
        const query = { email: email };
        const user = await userCollection.findOne(query);
        res.send(user);
    });

    // ২. উইনিং পার্সেন্টেজ ক্যালকুলেট করার জন্য API
    app.get('/my-winning-stats/:email', verifyToken, async (req, res) => {
        const email = req.params.email;
        if (email !== req.decoded.email) {
            return res.status(403).send({ message: 'forbidden access' });
        }

        // মোট কতগুলো পেমেন্ট করেছে (Total Participated)
        const totalParticipated = await paymentCollection.countDocuments({ email: email });
        
        // মোট কতগুলো জিতেছে (Total Wins)
        const totalWins = await paymentCollection.countDocuments({ email: email, status: 'winner' });

        res.send({ totalWins, totalParticipated });
    });

    // ================= USERS API =================
    
    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = { email: user.email };
      const existingUser = await userCollection.findOne(query);
      if (existingUser) {
        return res.send({ message: 'user already exists', insertedId: null });
      }
      const result = await userCollection.insertOne(user);
      res.send(result);
    });

    app.get('/users', verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });

    app.get('/best-creators', async (req, res) => {
        const result = await userCollection.find({ role: 'creator' })
            .limit(6)
            .toArray();
        res.send(result);
    });

    app.get('/users/role/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.decoded.email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const query = { email: email };
      const user = await userCollection.findOne(query);
      let role = 'user';
      if (user) {
        role = user?.role;
      }
      res.send({ role });
    });

    app.patch('/users/role/:id', verifyToken, verifyAdmin, async (req, res) => {
        const id = req.params.id;
        const role = req.body.role;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: { role: role } };
        const result = await userCollection.updateOne(filter, updatedDoc);
        res.send(result);
    });

    app.delete('/users/:id', verifyToken, verifyAdmin, async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await userCollection.deleteOne(query);
        res.send(result);
    });
    
    // Update User Profile
    app.put('/users/:email', verifyToken, async (req, res) => {
        const email = req.params.email;
        const data = req.body;
        const filter = { email: email };
        const updatedDoc = { $set: { ...data } };
        const result = await userCollection.updateOne(filter, updatedDoc, { upsert: true });
        res.send(result);
    });

    // ================= CONTESTS API =================
    
    app.post('/contests', verifyToken, verifyCreator, async (req, res) => {
      const contest = req.body;
      const result = await contestCollection.insertOne(contest);
      res.send(result);
    });

    // ✅✅ UPDATED WITH PAGINATION LOGIC ✅✅
    app.get('/contests', async (req, res) => {
        const page = parseInt(req.query.page) || 0;
        const size = parseInt(req.query.size) || 10;
        const search = req.query.search || "";
        const type = req.query.type || "";
        
        let query = { status: 'accepted' };
        
        if (search) {
            query.contestType = { $regex: search, $options: 'i' };
        }
        if(type && type !== 'All') {
            query.contestType = type;
        }

        // মোট ডাটার সংখ্যা বের করা হচ্ছে (ফিল্টার অনুযায়ী)
        const total = await contestCollection.countDocuments(query);

        const result = await contestCollection.find(query)
            .skip(page * size)
            .limit(size)
            .toArray();
            
        res.send({ result, total });
    });

    app.get('/contests/popular', async(req, res) => {
        const result = await contestCollection.find({status: 'accepted'}) 
        .sort({participationCount: -1})
        .limit(6)
        .toArray();
        res.send(result);
    });

    app.get('/contests/:id', async (req, res) => {
      const id = req.params.id;
      const result = await contestCollection.findOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // Creator's Contests
    app.get('/contests/creator/:email', verifyToken, verifyCreator, async(req, res) => {
        const email = req.params.email;
        const result = await contestCollection.find({creatorEmail: email}).toArray();
        res.send(result);
    });

    // Update Contest
    app.put('/contests/update/:id', verifyToken, verifyCreator, async (req, res) => {
        const id = req.params.id;
        const data = req.body;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = {
            $set: {
                contestName: data.contestName,
                image: data.image,
                contestType: data.contestType,
                description: data.description,
                price: data.price,
                prizeMoney: data.prizeMoney,
                taskInstruction: data.taskInstruction,
                deadline: data.deadline
            }
        };
        const result = await contestCollection.updateOne(filter, updatedDoc);
        res.send(result);
    });

    app.delete('/contests/:id', verifyToken, verifyCreator, async (req, res) => {
        const id = req.params.id;
        const result = await contestCollection.deleteOne({ _id: new ObjectId(id) });
        res.send(result);
    });

    // Admin All Contests
    app.get('/contests/admin/all', verifyToken, verifyAdmin, async(req, res) => {
        const result = await contestCollection.find().toArray();
        res.send(result);
    });

    app.patch('/contests/status/:id', verifyToken, verifyAdmin, async(req, res) => {
        const id = req.params.id;
        const status = req.body.status;
        const filter = { _id: new ObjectId(id) };
        const updatedDoc = { $set: { status: status } };
        const result = await contestCollection.updateOne(filter, updatedDoc);
        res.send(result);
    });

    // ================= PAYMENT API =================
    
    app.post('/create-payment-intent', verifyToken, async (req, res) => {
      const { price } = req.body;
      const amount = parseInt(price * 100);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: 'usd',
        payment_method_types: ['card']
      });
      res.send({ clientSecret: paymentIntent.client_secret });
    });

    app.post('/payments', verifyToken, async (req, res) => {
        const payment = req.body;
        const paymentResult = await paymentCollection.insertOne(payment);
        const filter = { _id: new ObjectId(payment.contestId) };
        const updateDoc = { $inc: { participationCount: 1 } };
        const contestResult = await contestCollection.updateOne(filter, updateDoc);
        res.send({ paymentResult, contestResult });
    });

    app.get('/payments', verifyToken, async (req, res) => {
      const email = req.query.email;
      if (req.decoded.email !== email) {
        return res.status(403).send({ message: 'forbidden access' });
      }
      const result = await paymentCollection.aggregate([
        { $match: { email: email } },
        {
            $lookup: {
                from: 'contests',
                let: { contestIdObj: { $toObjectId: "$contestId" } }, 
                pipeline: [
                    { $match: { $expr: { $eq: ["$_id", "$$contestIdObj"] } } }
                ],
                as: 'contestDetails'
            }
        },
        { $unwind: '$contestDetails' },
        {
            $project: {
                _id: 1,
                price: 1,
                transactionId: 1,
                date: 1,
                status: 1, 
                contestId: 1,
                taskSubmission: 1, 
                contestName: '$contestDetails.contestName',
                contestType: '$contestDetails.contestType',
                image: '$contestDetails.image',
                prizeMoney: '$contestDetails.prizeMoney',
                deadline: '$contestDetails.deadline'
            }
        },
        { $sort: { _id: -1 } }
      ]).toArray();
      res.send(result);
    });

    // ================= SUBMISSION & WINNER API =================

    // User Submits Task
    app.put('/contest/submit/:id', verifyToken, async (req, res) => {
      const id = req.params.id; 
      const { taskSubmission } = req.body; 

      const filter = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: {
          taskSubmission: taskSubmission, 
          status: 'submitted'
        }
      }
      const result = await paymentCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    app.get('/contest/submissions/:id', verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const query = { contestId: id, status: 'submitted' };
      const result = await paymentCollection.find(query).toArray();
      res.send(result);
    });

    app.patch('/contest/winner/:id', verifyToken, verifyCreator, async(req, res) =>{
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const updateDoc = { $set: { status: 'winner' } }
      const result = await paymentCollection.updateOne(filter, updateDoc);
      res.send(result);
    });

    // ================= LEADERBOARD & STATS =================

    app.get('/leaderboard', async (req, res) => {
        const result = await paymentCollection.aggregate([
            { $match: { status: 'winner' } },
            { $group: { _id: "$email", winCount: { $sum: 1 } } },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: 'email',
                    as: 'userInfo'
                }
            },
            { $unwind: "$userInfo" },
            {
                $project: {
                    _id: 1, winCount: 1,
                    name: "$userInfo.name",
                    photo: "$userInfo.photo"
                }
            },
            { $sort: { winCount: -1 } },
            { $limit: 10 } 
        ]).toArray();
        res.send(result);
    });

    app.get('/admin-stats', verifyToken, verifyAdmin, async(req, res) => {
        const users = await userCollection.estimatedDocumentCount();
        const contests = await contestCollection.estimatedDocumentCount();
        const orders = await paymentCollection.estimatedDocumentCount();
        const paymentDetails = await paymentCollection.aggregate([
          { $group: { _id: null, totalRevenue: { $sum: "$price" } } }
        ]).toArray();
        const revenue = paymentDetails.length > 0 ? paymentDetails[0].totalRevenue : 0;
        res.send({ users, contests, orders, revenue });
    });

    app.get('/', (req, res) => {
      res.send('ContestHub Server is Running');
    });
    
  } finally {}
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`ContestHub is sitting on port ${port}`);
});