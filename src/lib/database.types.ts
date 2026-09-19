// Hand-written types matching the additive Supabase migrations.
// Kept intentionally minimal (only what the app queries) rather than full generated types.

export type GigStatus =
  | "draft"
  | "active"
  | "in_progress"
  | "awaiting_payment"
  | "completed"
  | "incomplete"
  | "disputed"
  | "cancelled";

export type PriceType = "fixed" | "negotiable";
export type ClaimState = "pending" | "selected" | "rejected" | "withdrawn";
export type CompletionOutcome = "complete" | "incomplete";
export type IncompleteChoice = "partial_pay" | "no_pay";
export type FeedbackType = "wom" | "lemon" | "skip";

export interface Profile {
  id: string;
  username: string;
  photo_url: string | null;
  skills: string[];
  services: string[];
  wom_count: number;
  lemon_count: number;
  money_made: number;
  created_at: string;
  private_location_text: string | null;
  private_lat: number | null;
  private_lng: number | null;
  onboarding_completed_at: string | null;
}

export interface PublicProfile {
  id: string;
  username: string;
  photo_url: string | null;
  skills: string[];
  wom_count: number;
}

export interface Gig {
  id: string;
  creation_request_id: string | null;
  poster_id: string;
  service_type: string;
  title: string;
  description: string;
  photo_url: string | null;
  amount: number;
  price_type: PriceType;
  scheduled_at: string | null;
  location_text: string | null;
  lat: number | null;
  lng: number | null;
  status: GigStatus;
  selected_provider_id: string | null;
  start_requested_at: string | null;
  start_approved_at: string | null;
  resolution_path: "complete" | "partial_pay" | null;
  incomplete_choice_phase: boolean;
  amount_paid: number | null;
  amount_received: number | null;
  created_at: string;
}

export interface Claim {
  id: string;
  gig_id: string;
  provider_id: string;
  state: ClaimState;
  created_at: string;
}

export interface ChatMessage {
  id: string;
  gig_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export interface Notification {
  id: string;
  recipient_id: string;
  gig_id: string | null;
  type: string;
  message: string;
  read: boolean;
  created_at: string;
}

export interface Database {
  public: {
    Tables: {
      profiles: { Row: Profile; Insert: Partial<Profile>; Update: Partial<Profile> };
      public_profiles: { Row: PublicProfile; Insert: Partial<PublicProfile>; Update: Partial<PublicProfile> };
      gigs: { Row: Gig; Insert: Partial<Gig>; Update: Partial<Gig> };
      claims: { Row: Claim; Insert: Partial<Claim>; Update: Partial<Claim> };
      chat_messages: { Row: ChatMessage; Insert: Partial<ChatMessage>; Update: Partial<ChatMessage> };
      notifications: { Row: Notification; Insert: Partial<Notification>; Update: Partial<Notification> };
    };
    Functions: {
      ensure_profile: { Args: Record<string, never>; Returns: Profile };
      save_onboarding: { Args: { p_username: string; p_photo_url: string | null; p_location_text: string; p_lat: number | null; p_lng: number | null; p_skills: string[]; p_services: string[] }; Returns: Profile };
      create_gig: { Args: { p_request_id: string; p_service_type: string; p_title: string; p_description: string; p_amount: number; p_price_type: string; p_scheduled_at: string | null; p_location_text: string; p_lat: number | null; p_lng: number | null; p_photo_url?: string | null; p_publish?: boolean }; Returns: Gig };
      create_claim: { Args: { p_gig_id: string }; Returns: Claim };
      select_provider: { Args: { p_gig_id: string; p_claim_id: string }; Returns: void };
      request_start: { Args: { p_gig_id: string }; Returns: void };
      approve_start: { Args: { p_gig_id: string }; Returns: void };
      submit_completion: { Args: { p_gig_id: string; p_outcome: CompletionOutcome }; Returns: void };
      submit_incomplete_choice: { Args: { p_gig_id: string; p_choice: IncompleteChoice }; Returns: void };
      submit_payment_amount: { Args: { p_gig_id: string; p_amount: number }; Returns: void };
      submit_feedback: { Args: { p_gig_id: string; p_type: FeedbackType }; Returns: void };
      publish_gig: { Args: { p_gig_id: string }; Returns: void };
      cancel_gig: { Args: { p_gig_id: string }; Returns: void };
      get_public_stats: { Args: { p_profile_id: string }; Returns: { gigs_worked_count: number; wom_count: number }[] };
    };
  };
}
