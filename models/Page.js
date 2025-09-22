import { DataTypes } from "sequelize";
import sequelize from "../db/connectDB.js"; // Sequelize instance

const Page = sequelize.define("Page", {
  url: {
    type: DataTypes.STRING(700), 
    allowNull: false,
    unique: true,
  },
  title: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  content: {
    type: DataTypes.TEXT("long"),
    allowNull: true,
  },
});

export default Page;