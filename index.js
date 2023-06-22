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
        maxResults: constraints["numVideos"],
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
          getPlaylistItems(youtube, channel, constraints)
        );
        resolve(Promise.all(promiseList));
      })
  });
}

// Use for users with no data/use on video clicked
function getVideosBySubscribers(youtube, constraints={numSubscriptions: 5, numVideos: 5}) {
  return new Promise(async (resolve) => {
    await youtube.subscriptions
      .list({
        part: "snippet,contentDetails",
        mine: "true",
        maxResults: constraints["numSubscriptions"],
      })
      .then(async (data) => {
        let channelIds = [];
        data.data.items.forEach((channel) => {
          channelIds.push(channel.snippet.resourceId.channelId);
        });
        getChannels(youtube, channelIds, constraints).then((channels) => {
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

function writeVideoDataToDatabase(cid, mongoClient, bfg) {
  const videoDataWrites = [];
  const usageDataWrites = [];
  bfg.forEach((item) => {
    // both videos and usage data
    const videoId = item["id"];

    // only video data
    const videoTitle = item["snippet"]["title"];
    const channelId = item["snippet"]["channelId"];
    const channelTitle = item["snippet"]["channelTitle"];
    const views = 0;
    const uploadDate = "";
    const videoLength = item["contentDetails"]["duration"];
    const categoryId = item["snippet"]["categoryId"];
    const thumbnail = item["snippet"]["thumbnails"]["default"]["url"];

    // only usage data
    const timeSpentWatching = 0;
    const numClicks = 0;
    const numTimesShown = 0;
    const rawScore = 0;
    const isLiked = 0; // -1, 0, 1
    const isSubscribed = false;

    videoDataWrites.push(
      {
        updateOne: {
          filter: { [videoId]: {$exists: true}},
          update: {$set: { [videoId]: {
            videoTitle: videoTitle,
            channelId: channelId,
            channelTitle: channelTitle,
            views: views,
            uploadDate: uploadDate,
            videoLength: videoLength,
            categoryId: categoryId,
            thumbnail: thumbnail
          }}},
          upsert: true
        }
      }
    );

    usageDataWrites.push(
      {
        updateOne: {
          filter: { [`${cid}`]: {$exists: true}},
          update: {$set: { [`${cid}.data.${videoId}`]: {
            timeSpentWatching: timeSpentWatching,
            numClicks: numClicks,
            numTimesShown: numTimesShown,
            isLiked: isLiked,
            isSubscribed: isSubscribed,
            rawScore: rawScore
          }}},
          upsert: true
        }
      }
    );
  });

  const db = mongoClient.db(DBNAME);
  const profilesCollection = db.collection("dev");
  const videosCollection = db.collection("videos");

  try {
    videosCollection.bulkWrite(videoDataWrites);
  } catch (err) {
    console.error(err);
  }

  try {
    profilesCollection.bulkWrite(usageDataWrites);
  } catch (err) {
    console.error(err);
  }
}

function filterVideos(videos, filters) {
  for (let i = 0; i < videos.length; i++) {
    const category =  YOUTUBE_CATEGORY_IDS[videos[i]["snippet"]["categoryId"]];
    const duration = videos[i]["contentDetails"]["duration"];
    const minutesMatch = duration.match(/(\d+)M/);
    const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
    if (minutes < filters["vidlength"]) {
      // console.log(`Removing video because length was ${minutes}.`);
      videos[i] = null;
    }
    else if(Object.keys(filters).includes(category) && !filters[category]) {
      // console.log(`Removing video because category was ${category}.`);
      videos[i] = null;
    }
  }
  return videos;
}

function filterVideos2(videos, filters) {
  for (let i = 0; i < videos.length; i++) {
    const id = Object.keys(videos[i])[1];
    const metadata = videos[i][id];
    const category = YOUTUBE_CATEGORY_IDS[parseInt(metadata["categoryId"])];
    const duration = metadata["videoLength"];
    const minutesMatch = duration.match(/(\d+)M/);
    const minutes = minutesMatch ? parseInt(minutesMatch[1]) : 0;
    if (minutes < filters["vidlength"]) {
      // console.log(`Removing video because length was ${minutes}.`);
      videos[i] = null;
    }
    else if(Object.keys(filters).includes(category) && !filters[category]) {
      // console.log(`Removing video because category was ${category}.`);
      videos[i] = null;
    }
  }
  return videos;
}

// TODO: Massage bfg video data to be mongo compatible
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
  const userData = await collection.findOne(query);

  if (!userData) {
    return;
  }

  const filters = userData[cid]["settings"];
  const usageData = userData[cid]["data"];
  if (!usageData && filters) {
    const playlistItemsObj = await getVideosBySubscribers(youtube/*, {numSubscriptions: 100, numVideos: 40}*/);

    const idsList = [];
    playlistItemsObj.forEach((channel) => {
      channel.forEach((item) => {
        idsList.push(item["snippet"]["resourceId"]["videoId"]);
      });
    });
    const bigFriendlyObject = await getDetailedVideoInfo(youtube, idsList);
    const videos = bigFriendlyObject["data"]["items"];

    writeVideoDataToDatabase(cid, mongoClient, bigFriendlyObject["data"]["items"]);
  }

  res.status(269).send();
});

app.post("/retrieveVideos", async (req, res) => {
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
  const usageCollection = db.collection("dev");
  const videosCollection = db.collection("videos");
  const usageQuery = {[`${cid}.settings`]: {$exists: true}};
  const userData = await usageCollection.findOne(usageQuery);

  if (!userData) {
    return;
  }

  const filters = userData[cid]["settings"];
  const usageData = userData[cid]["data"];

  if (!filters || !usageData) {
    return;
  }
  const queryArray = Object.keys(usageData).map((key) => {
    return {[key]: {$exists: true}};
  });
  const videosQuery = { $or: queryArray };
  const videos = await videosCollection.find(videosQuery).toArray();
  const filteredVideos = filterVideos2(videos, filters);
  res.json(filteredVideos);
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

  try {
    req.body["vidlength"] = Math.max(parseInt(req.body["vidlength"]));
  } catch {
    req.body["vidlength"] = 0;
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
  collection.updateOne(query, update, {upsert: true});
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
  try {
    res.json(dbres[`${cid}`]["settings"]);
  } catch {
    res.json({
      vidlength: "0",
      gaming: true,
      music: true,
      other: true,
    });
  }
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
