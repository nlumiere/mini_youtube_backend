const express = require("express");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;
const cors = require("cors");
const bodyParser = require("body-parser");
const { MongoClient, ServerApiVersion } = require("mongodb");
const session = require("express-session");
require("dotenv").config();

const MONGO_URI = `mongodb+srv://${process.env.MONGO_USERNAME}:${process.env.MONGO_PASSWORD}@proto.deabf88.mongodb.net/?retryWrites=true&w=majority`;

const mongoClient = new MongoClient(MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

const DBNAME = "app";

async function mongoConnect() {
  try {
    await mongoClient.connect();
    console.log("connected to database");
  } catch (err) {
    console.error(err);
  }
}

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
    name: 'connect.sid',
    secret: "hehe-secret",
    resave: false,
    saveUninitialized: true,
    cookie: { 
      httpOnly: true,
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
      sameSite: 'lax', },
      path: '/'
    })
);

const YOUTUBE_CATEGORY_IDS = {
  10: "music",
  20: "gaming",
}
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
      })
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

function getDetailedVideoInfo(youtube, videoIds) {
  // TODO: Additional call (think about maybe reducing initial data)
  return new Promise(async (resolve) => {
    await youtube.videos.list({
      part: ["snippet", "contentDetails"],
      id: videoIds
    }).then((data) => {
      resolve(data);
    })
  });
}

app.post("/firstpass", async (req, res) => {
  const oauth2Client = getOAuth2Client(req);

  mongoConnect();

  if (!req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const cid = await getChannelUid(youtube);

  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[`${cid}.settings`]: {$exists: true}};
  const userPrefs = await collection.findOne(query);
  const filters = userPrefs[cid]["settings"]

  const playlistItemsObj = await firstPass(youtube);
  const idsList = [];
  playlistItemsObj.forEach((channel) => {
    channel.forEach((item) => {
      idsList.push(item["snippet"]["resourceId"]["videoId"]);
    });
  });
  const bigFriendlyObject = await getDetailedVideoInfo(youtube, idsList);
  const videos = bigFriendlyObject["data"]["items"];
  for (let i = 0; i < videos.length; i++) {
    const category =  YOUTUBE_CATEGORY_IDS[videos[i]["snippet"]["categoryId"]];
    const duration = videos[i]["contentDetails"]["duration"];
    const minutesMatch = duration.match(/(\d+)M/);
    const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
    if (minutes < filters["vidlength"]) {
      console.log(`Removing video because length was ${minutes}.`);
      videos[i] = null;
    }
    else if(Object.keys(filters).includes(category) && !filters[category]) {
      console.log(`Removing video because category was ${category}.`);
      videos[i] = null;
    }
  }
  res.json(bigFriendlyObject["data"]["items"]);
});

async function getChannelUid(youtube) {
  const data = await youtube.channels.list({
    part: "snippet",
    mine: true
  });
  return data.data.items[0].id;
}

app.post("/logout", (req, res) => {
  const oauth2Client = getOAuth2Client(req);
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      res.status(500).send("An error occurred while logging out.");
      return;
    }

    oauth2Client.setCredentials(null);

    oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
    });
    res.clearCookie('connect.sid', { path: '/', sameSite: 'lax', httpOnly: true, secure: false,maxAge: 24 * 60 * 60 * 1000 });
    res.redirect(CLIENT_REDIRECT_URI);
  });
});

app.post("/ping", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  res.send("pong");
});

app.post("/update_profile", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const cid = await getChannelUid(youtube);
  mongoConnect();

  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[`${cid}.settings`]: {$exists: true}};
  const update = {
    $set: {
      [`${cid}.settings`]: req.body
    }
  }
  collection.updateOne(query, update);
  res.json({status: "happy"});
});

app.post("/get_profile", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });
  const cid = await getChannelUid(youtube);
  mongoConnect();
  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[`${cid}.settings`]: {$exists: true}};
  const dbres = await collection.findOne(query);
  const userSettings = dbres[`${cid}`]["settings"];
  res.json(userSettings);
});

app.post("/debug", async (req, res) => {
  if (!req.session || !req.session.tokens) {
    res.status(401).send("Unauthorized");
    return;
  }

  const oauth2Client = getOAuth2Client(req);
  const youtube = google.youtube({
    version: "v3",
    auth: oauth2Client,
  });

  const cid = await getChannelUid(youtube);

  mongoConnect();
  const db = mongoClient.db(DBNAME);
  const collection = db.collection("dev");
  const query = {[cid]: {}};
  const update = {[cid]: {settings: {test: "test"}, data: {}}};
  collection.updateOne(query, {$set: update});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
