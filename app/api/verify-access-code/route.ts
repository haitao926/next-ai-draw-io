import { isAccessCodeRequired, isValidAccessCode } from "@/lib/access-code"

export async function POST(req: Request) {
    if (!isAccessCodeRequired()) {
        return Response.json({
            valid: true,
            message: "No access code required",
        })
    }

    const accessCodeHeader = req.headers.get("x-access-code")

    if (!isValidAccessCode(accessCodeHeader)) {
        return Response.json(
            { valid: false, message: "Invalid access code" },
            { status: 401 },
        )
    }

    return Response.json({ valid: true, message: "Access code is valid" })
}
