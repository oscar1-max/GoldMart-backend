const express = require("express");
const cors = require("cors");
require("dotenv").config();

const routes = require("./routes");

const app = express();

const PORT = process.env.PORT || 4000;

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

// API routes
app.use("/api", routes);

app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart API is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "GoldMart backend is healthy",
  });
});

app.listen(PORT, () => {
  console.log(`GoldMart API running on port ${PORT}`);
});
