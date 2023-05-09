const express = require("express");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const cors = require("cors");
const bodyParser = require("body-parser");
const { MongoClient } = require("mongodb");
const session = require("express-session");
require("dotenv").config();

const dburl = "mongodb://localhost:27017";
const mongoClient = new MongoClient(dburl);

const DBNAME = "app";

const corsOptions = {
  origin: "http://localhost:3001",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

const app = express();
app.use(express.json());
app.use(bodyParser.json());
app.use(cors(corsOptions));
app.use(
  session({
    secret: "hehe-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: "auto", maxAge: 86400000 },
  })
);

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3000/auth/google/callback";
const CLIENT_REDIRECT_URI = "http://localhost:3001";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/plus.me",
];

function getOAuth2Client(req) {
  const oauth2Client = new OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (req.session.tokens) {
    oauth2Client.setCredentials(req.session.tokens);
  }
  return oauth2Client;
}

app.get("/auth", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
  });
  res.json({ auth_url: authUrl });
});

app.get("/auth/google/callback", async (req, res) => {
  const { code } = req.query;
  const oauth2Client = getOAuth2Client(req);
  const { tokens } = await oauth2Client.getToken(code);
  req.session.tokens = tokens;
  res.redirect(CLIENT_REDIRECT_URI);
});

async function mongoConnect() {
  await mongoClient.connect();
  console.log("Connected to database");
  const db = mongoClient.db(DBNAME);
  const collection = db.collection("test");
  console.log(collection);
  return "done.";
}

function getPlaylistItems(youtube, channel, constraints) {
  return new Promise((resolve) => {
    youtube.playlistItems
      .list({
        part: "id,snippet",
        playlistId: channel.contentDetails.relatedPlaylists.uploads,
        maxResults: 5,
      })
      .then((playlistItemsData) => {
        resolve(playlistItemsData.data.items);
      });
  });
}

function getChannels(youtube, channelIds, constraints) {
  return new Promise((resolve) => {
    youtube.channels
      .list({
        part: "contentDetails,statistics",
        id: channelIds,
      })
      .then((channelData) => {
        const promiseList = channelData.data.items.map((channel) =>
          getPlaylistItems(youtube, channel)
        );
        resolve(Promise.all(promiseList));
      });
  });
}

function firstPass(youtube, constraints = {}) {
  return new Promise(async (resolve) => {
    await youtube.subscriptions
      .list({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: 5,
      })
      .then(async (data) => {
        let channelIds = [];
        data.data.items.forEach((channel) => {
          channelIds.push(channel.snippet.resourceId.channelId);
        });
        getChannels(youtube, channelIds).then((channels) => {
          resolve(channels);
        });
      });
  });
}

app.post("/firstpass", async (req, res) => {
  const oauth2Client = getOAuth2Client(req);

  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const bigFriendlyObject = await firstPass(youtube);
  res.json(bigFriendlyObject);
});

app.post("/logout", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      res.status(500).send("An error occurred while logging out.");
      return;
    }

    oauth2Client.setCredentials(null);

    res.redirect(CLIENT_REDIRECT_URI);
  });
});

// FOR TESTING ONLY, REMOVE BEFORE PRODUCTION OF ANY KIND
app.post("/ping", async (req, res) => {
  const oauth2Client = getOAuth2Client(req);

  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  console.log("CREDENTIALS", oauth2Client.credentials);

  // const youtube = google.youtube({
  //   version: "v3",
  //   auth: oauth2Client,
  // });
  // youtube.channels
  //   .list({
  //     part: "snippet,statistics",
  //     mine: "true",
  //     access_token: oauth2Client.credentials.access_token,
  //   })
  //   .then((response) => {
  //     console.log(response.data.items);
  //   });

  res.send("pong");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
