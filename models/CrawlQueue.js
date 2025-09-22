import { DataTypes } from "sequelize";
import sequelize from "../db/connectDB.js";

const CrawlQueue = sequelize.define(
  "CrawlQueue",
  {
    url: {
      type: DataTypes.STRING(700),
      allowNull: false,
      unique: true,
    },
    status: {
      type: DataTypes.ENUM("queued", "processing", "done", "failed"),
      allowNull: false,
      defaultValue: "queued",
    },
    depth: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    priority: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    attempts: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    lastError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    indexes: [
      { fields: ["status", "priority"], using: "BTREE" },
      { fields: ["depth"], using: "BTREE" },
    ],
  }
);

export default CrawlQueue; 