import { Handler, HandlerContext, HandlerEvent, HandlerResponse } from "@netlify/functions";
import { Resend } from 'resend'

export const handler: Handler = async (
    event: HandlerEvent,
    context: HandlerContext,
): Promise<HandlerResponse> => {
    try {
        const apiKey = process.env.RESEND_KEY;

        const resend = new Resend(apiKey)

        const { data, error } = await resend.contacts.create({
            email: JSON.parse(event.body || '{}').email,
            unsubscribed: false,
            segments: [{
                id: '2971a6f1-43c0-483a-baf9-00be189b3384'
            }]
        });

        if (error) {
            console.log(error);
            throw new Error('Error saving email')
        }

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*',
            },
            body: JSON.stringify({
                success: true
            }),
        };
    } catch (error) {
        console.log('Error in handler:', error);

        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*', // Replace 3000 with your actual port
                'Access-Control-Allow-Headers': '*',
                'Access-Control-Allow-Methods': '*',
            },
            body: JSON.stringify({ error: 'Internal Server Error', message: error, success: false }),
        };
    }
};