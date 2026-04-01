import express from "express";
import { validateApiKey } from "../../middleware/auth";
import { createPostScreenshot } from "./post-screenshot.controller";
import { ROUTES_SCREENSHOT } from "./post-screenshot.routes";

const router = express.Router();
router.post(ROUTES_SCREENSHOT.POST_SCREENSHOT, validateApiKey, createPostScreenshot);

export const postScreenshotRouter = router;