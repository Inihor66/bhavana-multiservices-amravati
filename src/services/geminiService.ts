import { GoogleGenAI } from "@google/genai";

export async function getAiResponse(message: string, language: string, hasSentPhoto: boolean) {
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    
    const prompt = `You are a friendly and professional customer support assistant for BHAVANA MULTISERVICES. 
    The user is communicating in ${language}. 
    
    Your style: Casual yet professional, with a warm human touch. Think of yourself as a helpful neighbor who is also an expert.
    
    Guidelines:
    1. RELEVANCE: Respond directly to what the user said. Don't be a robot. If they say "hi", say "hi" back warmly.
    2. CONCISENESS: Keep it short and sweet (1-2 sentences).
    3. HUMAN TOUCH: Use natural phrasing. Avoid overly formal or corporate jargon.
    4. MANDATORY CLOSING: You must end your message by letting them know our team is looking into it. Use variations like: "Our team is checking this out and will get back to you soon!" or "We're on it! Someone from our team will reach out shortly."
    5. PHOTOS: If they haven't sent a photo yet (hasSentPhoto: ${hasSentPhoto}), suggest it naturally: "A quick photo of the issue would really help us see what's going on!"
    6. CONTACT: For urgent help, they can call us 24/7 at 9881345984.
    7. LANGUAGE: Speak ONLY in ${language}.
    
    User message: ${message}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
    });

    return response.text || "I'm checking on that for you! Our team will get back to you soon.";
  } catch (error) {
    console.error("Gemini Service Error:", error);
    // Return a friendly fallback instead of just throwing
    return "Thank you for your message! Our team is processing your request and will get back to you shortly. For urgent matters, please call 9881345984.";
  }
}
