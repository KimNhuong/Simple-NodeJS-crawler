import sequelize from "./db/connectDB.js";
import crawl from "./crawler/crawler.js";


const BASE_URL = "https://vnexpress.net/"; // Thay bằng base URL bạn muốn crawl
const INTERVAL_MS = 3 * 60 * 1000; // 3 phút

async function runOnce() {
  try {
    await crawl(BASE_URL, 2); // depth = 2
    console.log("Crawl finished ✅");
  } catch (err) {
    console.error("Crawl error:", err);
  }
}

async function main() {
  try {
    await sequelize.sync({ alter: true }); // đồng bộ database và tự động cập nhật schema
    console.log("DB synced ✅");

    // Run immediately, then every 3 minutes
    await runOnce();
    setInterval(runOnce, INTERVAL_MS);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

main();
