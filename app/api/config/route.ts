import { NextResponse } from "next/server"
import { isAccessCodeRequired } from "@/lib/access-code"
import { getModelAllowlistFromEnv } from "@/lib/model-allowlist"

export async function GET() {
    return NextResponse.json({
        accessCodeRequired: isAccessCodeRequired(),
        modelAllowlist: getModelAllowlistFromEnv(),
        dailyRequestLimit: Number(process.env.DAILY_REQUEST_LIMIT) || 0,
        dailyTokenLimit: Number(process.env.DAILY_TOKEN_LIMIT) || 0,
        tpmLimit: Number(process.env.TPM_LIMIT) || 0,
    })
}
